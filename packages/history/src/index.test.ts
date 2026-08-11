import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  acquireSaveHistoryWatcher,
  compareWatchedSave,
  compareWatchedSaveRepositories,
  copyRepositorySnapshot,
  diffCommits,
  getSaveState,
  initSaveHistory,
  inspectSaveHistoryRepository,
  InvalidRestoreBackupDirectoryError,
  migrateSaveHistoryRepository,
  observeSave,
  preflightInPlaceRestore,
  prepareRepositoryReplacement,
  prepareSaveHistoryMigration,
  queryHistory,
  queryRawObservations,
  readEncodedSave,
  rebuildSemanticReadModel,
  relocateRepository,
  RestoreConflictError,
  restoreEncodedSave,
  RestoreTargetExistsError,
  SaveHistoryRepositoryIncompatibleError,
  SaveHistoryWatcherAlreadyAcquiredError,
  searchSemanticEvents,
  WatchedSaveUnavailableError,
} from "./index.ts";
import {
  withRepositoryLeaseReleaseFailuresForTests,
  withRepositorySnapshotFileSystemForTests,
} from "./repository-compatibility.ts";
import type { ProjectConfigOverrides } from "./types.ts";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "../../core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const unrecognizedEncodedSavePath = path.join(
  fixtureDirectory,
  "unrecognized-schema-save.dat",
);
const maskShard2CollectedEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-save.dat",
);
const maskShard2CollectedRosariesEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-rosaries-save.dat",
);
async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-history-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

type ObserveSaveResult = Awaited<ReturnType<typeof observeSave>>;
type CommittedObserveSaveResult = Extract<
  ObserveSaveResult,
  { readonly status: "committed" }
>;

interface HistoryRepoFixture {
  readonly tempDirectory: string;
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly configPath: string;
  readonly stagingRootPath: string;
}

interface ObservedFixtureSequence extends HistoryRepoFixture {
  readonly observations: readonly CommittedObserveSaveResult[];
}

async function createHistoryRepo(
  t: TestContext,
  initialSavePath = minimalEncodedSavePath,
  config?: ProjectConfigOverrides,
): Promise<HistoryRepoFixture> {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");
  const stagingRootPath = path.join(tempDirectory, "staging");

  await copyFile(initialSavePath, watchedSavePath);
  const initialized = await initSaveHistory({
    repoPath,
    watchedSavePath,
    config,
  });
  await mkdir(stagingRootPath);

  return {
    tempDirectory,
    repoPath,
    watchedSavePath,
    configPath: initialized.configPath,
    stagingRootPath,
  };
}

async function createDifferentFilesystemDirectory(
  t: TestContext,
  referencePath: string,
): Promise<string> {
  const referenceMetadata = await stat(referencePath, { bigint: true });
  const referenceDevice = referenceMetadata.dev;
  for (const candidateRoot of ["/dev/shm", "/var/tmp", "/tmp"]) {
    const candidateMetadata = await stat(candidateRoot, { bigint: true }).catch(
      () => undefined,
    );
    if (
      candidateMetadata === undefined
      || candidateMetadata.dev === referenceDevice
    ) {
      continue;
    }

    const directory = await mkdtemp(
      path.join(candidateRoot, "silksong-history-cross-filesystem-"),
    ).catch(() => undefined);
    if (directory === undefined) {
      continue;
    }
    t.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    return directory;
  }

  t.skip("No writable second filesystem is available for this regression.");
  throw new Error(
    "No writable second filesystem is available for this regression.",
  );
}

async function setRepositoryFormatVersion(
  repo: HistoryRepoFixture,
  repositoryFormatVersion: number | undefined,
) {
  // Fixture construction only: the public migration Interface intentionally does not permit a test
  // to manufacture an older durable format.
  const config = JSON.parse(await readFile(repo.configPath, "utf8")) as Record<
    string,
    unknown
  >;

  if (repositoryFormatVersion === undefined) {
    delete config["repositoryFormatVersion"];
  } else {
    config["repositoryFormatVersion"] = repositoryFormatVersion;
  }

  await writeFile(repo.configPath, `${JSON.stringify(config)}\n`);
}

async function removeSemanticReadModelFixture(repo: HistoryRepoFixture) {
  // Fixture construction only: public History behavior deliberately offers no operation that
  // corrupts or removes a derived Semantic Read Model.
  await rm(path.join(repo.repoPath, ".silksong-git/read-model.sqlite"), {
    force: true,
  });
}

async function corruptUnreachableGitObject(repoPath: string) {
  const objectSourcePath = path.join(repoPath, "corrupt-object-source");
  await writeFile(objectSourcePath, "unreachable object");
  const objectIdOutput = await runGitOutput(repoPath, [
    "hash-object",
    "-w",
    objectSourcePath,
  ]);
  const objectId = objectIdOutput.trim();
  const objectPath = path.join(
    repoPath,
    ".git",
    "objects",
    objectId.slice(0, 2),
    objectId.slice(2),
  );
  await chmod(objectPath, 0o600);
  await writeFile(objectPath, "corrupt object");
}

async function runGitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr));
        return;
      }
      resolve(stdout);
    });
  });
}

async function observeFixture(
  repo: HistoryRepoFixture,
  fixturePath: string,
  observedAt: Date,
): Promise<ObserveSaveResult> {
  await copyFile(fixturePath, repo.watchedSavePath);

  return await observeSave({
    repoPath: repo.repoPath,
    observedAt,
  });
}

async function observeFixtureSequence(
  t: TestContext,
  fixturePaths: readonly string[],
): Promise<ObservedFixtureSequence> {
  const [initialFixturePath] = fixturePaths;

  assert.ok(initialFixturePath !== undefined);

  const repo = await createHistoryRepo(t, initialFixturePath);
  const observations: CommittedObserveSaveResult[] = [];

  async function observeNextFixture(index: number) {
    const fixturePath = fixturePaths[index];

    if (fixturePath !== undefined) {
      const result = await observeFixture(
        repo,
        fixturePath,
        new Date(`2026-06-30T12:${index.toString().padStart(2, "0")}:00.000Z`),
      );

      assert.equal(result.status, "committed");
      observations.push(result);

      await observeNextFixture(index + 1);
    }
  }

  await observeNextFixture(0);

  return {
    ...repo,
    observations,
  };
}

test("initSaveHistory creates a Save History Repository project config", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  const result = await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });

  assert.equal(result.repoPath, repoPath);
  const inspection = await inspectSaveHistoryRepository({ repoPath });
  assert.equal(inspection.status, "ready");
});

test("inspectSaveHistoryRepository classifies durable compatibility separately from the Semantic Read Model", async (t) => {
  const ready = await createHistoryRepo(t);
  const readyInspection = await inspectSaveHistoryRepository({
    repoPath: ready.repoPath,
  });
  assert.equal(readyInspection.status, "ready");
  assert.equal(readyInspection.requiredAction, "open");
  assert.deepEqual(readyInspection.capabilities, [
    "read",
    "observe",
    "restore",
    "rebuildReadModel",
    "watch",
  ]);

  const invalidInspection = await inspectSaveHistoryRepository({
    repoPath: path.join(ready.tempDirectory, "not-a-repository"),
  });
  assert.equal(invalidInspection.status, "invalid");
  assert.equal(invalidInspection.requiredAction, "chooseAnotherDirectory");

  const legacy = await createHistoryRepo(t);
  await setRepositoryFormatVersion(legacy, undefined);
  const legacyInspection = await inspectSaveHistoryRepository({
    repoPath: legacy.repoPath,
  });
  assert.equal(legacyInspection.status, "legacyConfig");
  assert.equal(legacyInspection.requiredAction, "confirmMigration");

  const older = await createHistoryRepo(t);
  await setRepositoryFormatVersion(older, 0);
  const olderInspection = await inspectSaveHistoryRepository({
    repoPath: older.repoPath,
  });
  assert.equal(olderInspection.status, "migrationRequired");
  assert.equal(olderInspection.requiredAction, "confirmMigration");

  const rebuild = await createHistoryRepo(t);
  const observation = await observeSave({ repoPath: rebuild.repoPath });
  assert.equal(observation.status, "committed");
  const encodedBefore = await readEncodedSave({
    repoPath: rebuild.repoPath,
    commitRef: observation.observation.commit.ref,
  });
  await removeSemanticReadModelFixture(rebuild);
  const rebuildInspection = await inspectSaveHistoryRepository({
    repoPath: rebuild.repoPath,
  });
  assert.equal(rebuildInspection.status, "rebuildRequired");
  assert.equal(rebuildInspection.requiredAction, "rebuildReadModel");
  assert.deepEqual(rebuildInspection.capabilities, ["rebuildReadModel"]);
  const assertRebuildRequired = (error: unknown) => {
    assert.ok(error instanceof SaveHistoryRepositoryIncompatibleError);
    assert.equal(error.status, "rebuildRequired");
    assert.deepEqual(error.capabilities, ["rebuildReadModel"]);
    return true;
  };
  await assert.rejects(
    queryHistory({ repoPath: rebuild.repoPath }),
    assertRebuildRequired,
  );
  await assert.rejects(
    queryRawObservations({ repoPath: rebuild.repoPath }),
    assertRebuildRequired,
  );
  await assert.rejects(
    diffCommits({
      repoPath: rebuild.repoPath,
      fromRef: observation.observation.commit.ref,
      toRef: observation.observation.commit.ref,
    }),
    assertRebuildRequired,
  );
  await assert.rejects(
    searchSemanticEvents({ repoPath: rebuild.repoPath, query: {} }),
    assertRebuildRequired,
  );
  await assert.rejects(
    getSaveState({ repoPath: rebuild.repoPath, selector: { kind: "latest" } }),
    assertRebuildRequired,
  );
  await assert.rejects(
    readEncodedSave({
      repoPath: rebuild.repoPath,
      commitRef: observation.observation.commit.ref,
    }),
    assertRebuildRequired,
  );
  await rebuildSemanticReadModel({ repoPath: rebuild.repoPath });
  const encodedAfter = await readEncodedSave({
    repoPath: rebuild.repoPath,
    commitRef: observation.observation.commit.ref,
  });
  assert.deepEqual(encodedAfter.encodedBytes, encodedBefore.encodedBytes);

  const newer = await createHistoryRepo(t);
  await setRepositoryFormatVersion(newer, 2);
  const newerInspection = await inspectSaveHistoryRepository({
    repoPath: newer.repoPath,
  });
  assert.equal(newerInspection.status, "newerIncompatible");
  assert.equal(newerInspection.requiredAction, "useNewerApp");
  assert.deepEqual(newerInspection.capabilities, []);
});

test("compareWatchedSave compares current and legacy-compatible configs without exposing config paths", async (t) => {
  const repo = await createHistoryRepo(t);
  const linkedSavePath = path.join(
    repo.tempDirectory,
    "linked-watched-save.dat",
  );
  await symlink(repo.watchedSavePath, linkedSavePath);

  assert.equal(
    await compareWatchedSave({
      repoPath: repo.repoPath,
      savePath: linkedSavePath,
    }),
    true,
  );

  await setRepositoryFormatVersion(repo, undefined);
  assert.equal(
    await compareWatchedSave({
      repoPath: repo.repoPath,
      savePath: repo.watchedSavePath,
    }),
    true,
  );

  await setRepositoryFormatVersion(repo, 0);
  assert.equal(
    await compareWatchedSave({
      repoPath: repo.repoPath,
      savePath: repo.watchedSavePath,
    }),
    true,
  );

  await writeFile(repo.configPath, '{"repositoryFormatVersion": 999}\n');
  await assert.rejects(
    compareWatchedSave({
      repoPath: repo.repoPath,
      savePath: repo.watchedSavePath,
    }),
    /not compatible with Watched Save comparison/v,
  );
});

test("copyRepositorySnapshot publishes a verified durable copy without changing the source", async (t) => {
  const repo = await createHistoryRepo(t);
  const configBefore = await readFile(repo.configPath);
  const readModelBefore = await readFile(
    path.join(repo.repoPath, ".silksong-git/read-model.sqlite"),
  );
  const targetPath = path.join(
    repo.tempDirectory,
    "managed",
    "imported-repository",
  );

  const result = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath,
    stagingRootPath: repo.stagingRootPath,
  });

  assert.equal(result.status, "copied");
  assert.equal(result.sourceStatus, "ready");
  assert.equal(result.snapshot.repoPath, targetPath);
  assert.deepEqual(await readFile(repo.configPath), configBefore);
  assert.deepEqual(
    await readFile(path.join(repo.repoPath, ".silksong-git/read-model.sqlite")),
    readModelBefore,
  );
  await assert.rejects(
    stat(path.join(targetPath, ".silksong-git/read-model.sqlite")),
  );
  const importedInspection = await inspectSaveHistoryRepository({
    repoPath: targetPath,
  });
  assert.equal(importedInspection.status, "rebuildRequired");
  assert.deepEqual(await readdir(repo.stagingRootPath), []);
});

test("copyRepositorySnapshot publishes when the source is on a different filesystem", async (t) => {
  const repo = await createHistoryRepo(t);
  const otherFilesystem = await createDifferentFilesystemDirectory(
    t,
    repo.tempDirectory,
  );
  const stagingRootPath = path.join(otherFilesystem, "staging");
  const targetPath = path.join(
    otherFilesystem,
    "managed",
    "imported-repository",
  );
  const configBefore = await readFile(repo.configPath);
  await mkdir(stagingRootPath);

  const result = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath,
    stagingRootPath,
  });

  assert.equal(result.status, "copied");
  assert.equal(result.snapshot.repoPath, targetPath);
  assert.deepEqual(await readdir(stagingRootPath), []);
  assert.deepEqual(await readFile(repo.configPath), configBefore);
  await assert.doesNotReject(stat(repo.repoPath));
});

test("migration preparation publishes when the source is on a different filesystem", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const otherFilesystem = await createDifferentFilesystemDirectory(
    t,
    repo.tempDirectory,
  );
  const stagingRootPath = path.join(otherFilesystem, "staging");
  const snapshotPath = path.join(otherFilesystem, "archives", "migration-copy");
  await mkdir(stagingRootPath);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });

  const result = await prepareSaveHistoryMigration({
    snapshotPath,
    stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });

  assert.equal(result.status, "prepared");
  assert.equal(result.operation.snapshot.repoPath, snapshotPath);
  assert.deepEqual(await readdir(stagingRootPath), []);
  await assert.doesNotReject(stat(snapshotPath));
  const migration = await result.operation.commit();
  assert.equal(migration.status, "migrated");
  await assert.doesNotReject(stat(repo.repoPath));
});

test("copyRepositorySnapshot rejects an initial staging filesystem mismatch before copying", async (t) => {
  const repo = await createHistoryRepo(t);
  const otherFilesystem = await createDifferentFilesystemDirectory(
    t,
    repo.tempDirectory,
  );
  const targetPath = path.join(otherFilesystem, "managed", "mismatched");
  let copied = false;

  const result = await withRepositorySnapshotFileSystemForTests(
    (fileSystem) => ({
      ...fileSystem,
      async copyRepository(sourcePath, stagingPath) {
        copied = true;
        await fileSystem.copyRepository(sourcePath, stagingPath);
      },
    }),
    async () =>
      await copyRepositorySnapshot({
        sourcePath: repo.repoPath,
        targetPath,
        stagingRootPath: repo.stagingRootPath,
      }),
  );

  assert.deepEqual(result, {
    status: "failed",
    reason: "publishFailed",
    sourceState: "unchanged",
    message:
      "The repository snapshot staging root or destination parent is not stable.",
  });
  assert.equal(copied, false);
  await assert.rejects(stat(targetPath));
  assert.deepEqual(await readdir(repo.stagingRootPath), []);
  await assert.doesNotReject(stat(repo.repoPath));
});

test("copyRepositorySnapshot rejects relative, missing, and symlinked staging roots", async (t) => {
  const repo = await createHistoryRepo(t);
  const targetRoot = path.join(
    repo.tempDirectory,
    "staging-validation-targets",
  );
  await mkdir(targetRoot);
  const outsideStagingRoot = path.join(repo.tempDirectory, "outside-staging");
  const symlinkedStagingRoot = path.join(repo.tempDirectory, "staging-link");
  await mkdir(outsideStagingRoot);
  await symlink(outsideStagingRoot, symlinkedStagingRoot, "dir");

  for (const [name, stagingRootPath] of [
    ["relative", path.relative(process.cwd(), repo.stagingRootPath)],
    ["missing", path.join(repo.tempDirectory, "missing-staging")],
    ["symlink", symlinkedStagingRoot],
  ] as const) {
    const result = await copyRepositorySnapshot({
      sourcePath: repo.repoPath,
      targetPath: path.join(targetRoot, name),
      stagingRootPath,
    });
    assert.deepEqual(result, {
      status: "rejected",
      reason: "invalidPlacement",
    });
  }
});

test("copyRepositorySnapshot cleans the operation directory after a final rename failure without retrying", async (t) => {
  const repo = await createHistoryRepo(t);
  const targetPath = path.join(repo.tempDirectory, "rename-failure");
  let renameAttempts = 0;
  const result = await withRepositorySnapshotFileSystemForTests(
    (fileSystem) => ({
      ...fileSystem,
      async renameSnapshot() {
        renameAttempts++;
        const error = new Error("cross-device rename");
        Object.assign(error, { code: "EXDEV" });
        throw error;
      },
    }),
    async () =>
      await copyRepositorySnapshot({
        sourcePath: repo.repoPath,
        targetPath,
        stagingRootPath: repo.stagingRootPath,
      }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "publishFailed");
  assert.equal(renameAttempts, 1);
  await assert.rejects(stat(targetPath));
  assert.deepEqual(await readdir(repo.stagingRootPath), []);
  await assert.doesNotReject(stat(repo.repoPath));

  const retry = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath,
    stagingRootPath: repo.stagingRootPath,
  });
  assert.equal(retry.status, "copied");
});

test("copyRepositorySnapshot rejects a symlinked target parent before publication", async (t) => {
  const repo = await createHistoryRepo(t);
  const outsideRoot = path.join(repo.tempDirectory, "outside-root");
  const managedRoot = path.join(repo.tempDirectory, "managed-root");
  await mkdir(outsideRoot);
  await symlink(outsideRoot, managedRoot, "dir");

  const result = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath: path.join(managedRoot, "imported-repository"),
    stagingRootPath: repo.stagingRootPath,
  });

  assert.deepEqual(result, {
    status: "rejected",
    reason: "invalidPlacement",
  });
  await assert.rejects(stat(path.join(outsideRoot, "imported-repository")));
});

test("copyRepositorySnapshot publishes collisions under the same real target parent", async (t) => {
  const repo = await createHistoryRepo(t);
  const targetPath = path.join(repo.tempDirectory, "managed", "imported");

  const first = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath,
    stagingRootPath: repo.stagingRootPath,
  });
  const second = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath,
    stagingRootPath: repo.stagingRootPath,
  });

  assert.equal(first.status, "copied");
  assert.equal(second.status, "copied");
  assert.equal(first.snapshot.repoPath, targetPath);
  assert.equal(second.snapshot.repoPath, `${targetPath}-1`);
  assert.notEqual(first.snapshot.directoryDigest, "");
  await assert.doesNotReject(stat(second.snapshot.repoPath));
});

test("copyRepositorySnapshot reports lease cleanup failures without removing source or snapshot", async (t) => {
  const repo = await createHistoryRepo(t);
  const targetPath = path.join(
    repo.tempDirectory,
    "managed",
    "cleanup-warning",
  );

  const result = await withRepositoryLeaseReleaseFailuresForTests(
    { watcher: true, writer: true },
    async () =>
      await copyRepositorySnapshot({
        sourcePath: repo.repoPath,
        targetPath,
        stagingRootPath: repo.stagingRootPath,
      }),
  );

  assert.equal(result.status, "copied");
  assert.equal(result.cleanupFailure, "leaseReleaseFailed");
  assert.equal(result.snapshot.repoPath, targetPath);
  await assert.doesNotReject(stat(repo.repoPath));
  await assert.doesNotReject(stat(targetPath));
});

test("copyRepositorySnapshot retains source state when the verified copy digest changes", async (t) => {
  const repo = await createHistoryRepo(t);
  const configBefore = await readFile(repo.configPath);
  const readModelBefore = await readFile(
    path.join(repo.repoPath, ".silksong-git/read-model.sqlite"),
  );
  const mutationPath = path.join(repo.repoPath, "copy-mutation-marker");
  const targetPath = path.join(
    repo.tempDirectory,
    "managed",
    "digest-mismatch",
  );
  let result: Awaited<ReturnType<typeof copyRepositorySnapshot>>;
  try {
    result = await withRepositorySnapshotFileSystemForTests(
      (fileSystem) => ({
        ...fileSystem,
        async copyRepository(sourcePath, stagingPath) {
          await fileSystem.copyRepository(sourcePath, stagingPath);
          await writeFile(mutationPath, "source changed during copy");
        },
      }),
      async () =>
        await copyRepositorySnapshot({
          sourcePath: repo.repoPath,
          targetPath,
          stagingRootPath: repo.stagingRootPath,
        }),
    );
  } finally {
    await rm(mutationPath, { force: true });
  }

  assert.deepEqual(result, {
    status: "failed",
    reason: "directoryDigestMismatch",
    sourceState: "unchanged",
    message:
      "The source changed while the repository snapshot was being copied.",
  });
  await assert.rejects(stat(targetPath));
  await assert.doesNotReject(stat(repo.repoPath));
  assert.deepEqual(await readFile(repo.configPath), configBefore);
  assert.deepEqual(
    await readFile(path.join(repo.repoPath, ".silksong-git/read-model.sqlite")),
    readModelBefore,
  );
});

test("copyRepositorySnapshot accepts legacy and migration-required sources but rejects newer and invalid sources", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const legacy = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath: path.join(repo.tempDirectory, "legacy-copy"),
    stagingRootPath: repo.stagingRootPath,
  });
  assert.equal(legacy.status, "copied");
  assert.equal(legacy.sourceStatus, "legacyConfig");

  await setRepositoryFormatVersion(repo, 0);
  const migrationCandidate = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath: path.join(repo.tempDirectory, "migration-copy"),
    stagingRootPath: repo.stagingRootPath,
  });
  assert.equal(migrationCandidate.status, "copied");
  assert.equal(migrationCandidate.sourceStatus, "migrationRequired");

  await setRepositoryFormatVersion(repo, 2);
  const newer = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath: path.join(repo.tempDirectory, "newer-copy"),
    stagingRootPath: repo.stagingRootPath,
  });
  assert.deepEqual(newer, {
    status: "rejected",
    reason: "newerIncompatible",
    sourceStatus: "newerIncompatible",
  });
  await assert.rejects(stat(path.join(repo.tempDirectory, "newer-copy")));

  const invalidRepositoryPath = path.join(
    repo.tempDirectory,
    "invalid-repository",
  );
  await mkdir(invalidRepositoryPath);
  const invalid = await copyRepositorySnapshot({
    sourcePath: invalidRepositoryPath,
    targetPath: path.join(repo.tempDirectory, "invalid-copy"),
    stagingRootPath: repo.stagingRootPath,
  });
  assert.deepEqual(invalid, {
    status: "rejected",
    reason: "invalidSource",
    sourceStatus: "invalid",
  });
});

test("compareWatchedSaveRepositories compares canonical Watched Save identity", async (t) => {
  const repo = await createHistoryRepo(t);
  const secondRepoPath = path.join(repo.tempDirectory, "second-history-repo");
  await initSaveHistory({
    repoPath: secondRepoPath,
    watchedSavePath: repo.watchedSavePath,
  });
  const otherSavePath = path.join(repo.tempDirectory, "other-save.dat");
  await copyFile(minimalEncodedSavePath, otherSavePath);
  const thirdRepoPath = path.join(repo.tempDirectory, "third-history-repo");
  await initSaveHistory({
    repoPath: thirdRepoPath,
    watchedSavePath: otherSavePath,
  });

  assert.equal(
    await compareWatchedSaveRepositories({
      leftRepoPath: repo.repoPath,
      rightRepoPath: secondRepoPath,
    }),
    true,
  );
  assert.equal(
    await compareWatchedSaveRepositories({
      leftRepoPath: repo.repoPath,
      rightRepoPath: thirdRepoPath,
    }),
    false,
  );

  const hardlinkSavePath = path.join(repo.tempDirectory, "hardlink-save.dat");
  await link(repo.watchedSavePath, hardlinkSavePath);
  const hardlinkRepoPath = path.join(
    repo.tempDirectory,
    "hardlink-history-repo",
  );
  await initSaveHistory({
    repoPath: hardlinkRepoPath,
    watchedSavePath: hardlinkSavePath,
  });
  assert.equal(
    await compareWatchedSaveRepositories({
      leftRepoPath: repo.repoPath,
      rightRepoPath: hardlinkRepoPath,
    }),
    true,
  );
});

test("copyRepositorySnapshot respects an externally acquired watcher", async (t) => {
  const repo = await createHistoryRepo(t);
  const watcher = await acquireSaveHistoryWatcher({ repoPath: repo.repoPath });
  t.after(async () => {
    await watcher.release();
  });

  const result = await copyRepositorySnapshot({
    sourcePath: repo.repoPath,
    targetPath: path.join(repo.tempDirectory, "watcher-copy"),
    stagingRootPath: repo.stagingRootPath,
  });

  assert.deepEqual(result, {
    status: "failed",
    reason: "watcherAlreadyAcquired",
    sourceState: "unchanged",
  });
  await assert.rejects(stat(path.join(repo.tempDirectory, "watcher-copy")));
});

test("migrateSaveHistoryRepository requires confirmation, a fresh inspection, and creates a recoverable backup", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const initialInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  assert.equal(initialInspection.status, "legacyConfig");

  const unconfirmed = await migrateSaveHistoryRepository({
    repoPath: repo.repoPath,
    inspectionId: initialInspection.inspectionId,
    confirmation: "not-confirmed",
  });
  assert.equal(unconfirmed.status, "rejected");
  assert.equal(unconfirmed.reason, "confirmationRequired");
  assert.equal(unconfirmed.sourceState, "unchanged");
  assert.deepEqual(unconfirmed.snapshotState, { status: "notCreated" });

  await setRepositoryFormatVersion(repo, 0);
  const stale = await migrateSaveHistoryRepository({
    repoPath: repo.repoPath,
    inspectionId: initialInspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason, "staleInspection");
  assert.equal(stale.sourceState, "unchanged");
  assert.deepEqual(stale.snapshotState, { status: "notCreated" });

  const freshInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const migrated = await migrateSaveHistoryRepository({
    repoPath: repo.repoPath,
    inspectionId: freshInspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.backupCreated, true);
  assert.equal(migrated.inspection.status, "ready");
  assert.equal(migrated.sourceState, "migrated");
  assert.deepEqual(migrated.snapshotState, { status: "notCreated" });

  const consumedToken = await migrateSaveHistoryRepository({
    repoPath: repo.repoPath,
    inspectionId: freshInspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(consumedToken.status, "rejected");
  assert.equal(consumedToken.reason, "staleInspection");
  assert.equal(consumedToken.sourceState, "unchanged");
  assert.deepEqual(consumedToken.snapshotState, { status: "notCreated" });
});

test("migration preparation publishes a collision-safe verified snapshot before commit", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const snapshotBase = path.join(
    repo.tempDirectory,
    "snapshots",
    "save-snapshot",
  );

  const first = await prepareSaveHistoryMigration({
    snapshotPath: snapshotBase,
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(first.status, "prepared");
  assert.equal(first.operation.snapshot.repoPath, snapshotBase);
  assert.match(first.operation.snapshot.directoryDigest, /^[0-9a-f]{64}$/v);

  const committed = await first.operation.commit();
  assert.equal(committed.status, "migrated");
  assert.equal(committed.sourceState, "migrated");
  const firstSnapshot = await stat(snapshotBase);
  assert.ok(firstSnapshot.isDirectory());

  await setRepositoryFormatVersion(repo, undefined);
  const collisionInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const second = await prepareSaveHistoryMigration({
    snapshotPath: snapshotBase,
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: collisionInspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(second.status, "prepared");
  assert.equal(second.operation.snapshot.repoPath, `${snapshotBase}-1`);
  await second.operation.commit();
});

test("relocateRepository atomically moves an inspectable repository without changing config", async (t) => {
  const repo = await createHistoryRepo(t);
  const observed = await observeSave({ repoPath: repo.repoPath });
  assert.equal(observed.status, "committed");
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);
  const configBefore = await readFile(repo.configPath);

  const result = await relocateRepository({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
  });

  assert.equal(result.status, "relocated");
  assert.equal(
    result.destinationPath,
    path.join(destinationRoot, "history-repo-moved"),
  );
  await assert.rejects(stat(repo.repoPath));
  assert.deepEqual(
    await readFile(
      path.join(result.destinationPath, ".silksong-git", "config.json"),
    ),
    configBefore,
  );
  const exported = await readEncodedSave({
    repoPath: result.destinationPath,
    access: "readOnly",
    commitRef: observed.observation.commit.ref,
  });
  assert.deepEqual(exported.encodedBytes, await readFile(repo.watchedSavePath));
});

test("relocateRepository accepts unavailable children and avoids collisions", async (t) => {
  const root = await createTempDirectory(t);
  const sourcePath = path.join(root, "broken");
  const destinationRoot = path.join(root, "destinations");
  await mkdir(sourcePath);
  await mkdir(destinationRoot);
  await mkdir(path.join(destinationRoot, "broken-repository"));
  await writeFile(path.join(sourcePath, "opaque"), "unchanged");

  const result = await relocateRepository({
    sourcePath,
    targetPath: path.join(destinationRoot, "broken-repository"),
  });

  assert.equal(result.status, "relocated");
  assert.equal(
    result.destinationPath,
    path.join(destinationRoot, "broken-repository-2"),
  );
  assert.equal(
    await readFile(path.join(result.destinationPath, "opaque"), "utf8"),
    "unchanged",
  );
});

test("relocateRepository rejects symlinks, escapes, and active watcher ownership", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);
  const linked = path.join(repo.tempDirectory, "linked");
  await symlink(repo.repoPath, linked, "dir");

  assert.deepEqual(
    await relocateRepository({
      sourcePath: linked,
      targetPath: path.join(destinationRoot, "linked-repository"),
    }),
    { status: "failed", reason: "invalidPlacement" },
  );
  assert.deepEqual(
    await relocateRepository({
      sourcePath: repo.repoPath,
      targetPath: path.join(repo.repoPath, "escaped-destination"),
    }),
    { status: "failed", reason: "invalidPlacement" },
  );

  const watcher = await acquireSaveHistoryWatcher({ repoPath: repo.repoPath });
  const blocked = await relocateRepository({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
  });
  assert.deepEqual(blocked, {
    status: "failed",
    reason: "watcherAlreadyAcquired",
  });
  await watcher.release();
  await assert.doesNotReject(stat(repo.repoPath));
});

test("relocateRepository refuses an active writer lock with the source intact", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);
  const writerLock = await open(
    path.join(repo.repoPath, ".silksong-git", "write.lock"),
    "wx",
  );
  t.after(async () => {
    await writerLock.close();
    await rm(path.join(repo.repoPath, ".silksong-git", "write.lock"), {
      force: true,
    });
  });

  const result = await relocateRepository({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo"),
  });

  assert.deepEqual(result, {
    status: "failed",
    reason: "repositoryBusy",
  });
  await assert.doesNotReject(stat(repo.repoPath));
  await assert.rejects(stat(path.join(destinationRoot, "history-repo")));
});

test("relocateRepository reports an atomic move failure with the source intact", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);

  const result = await relocateRepository({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "x".repeat(300)),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "moveFailed");
  await assert.doesNotReject(stat(repo.repoPath));
  assert.deepEqual(await readdir(destinationRoot), []);
});

test("repository replacement prepares, commits, and releases leases at the moved destination", async (t) => {
  const repo = await createHistoryRepo(t);
  const observed = await observeSave({ repoPath: repo.repoPath });
  assert.equal(observed.status, "committed");
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);
  const replacementPath = path.join(repo.tempDirectory, "replacement-claim");
  await mkdir(replacementPath);
  await writeFile(path.join(replacementPath, "owned-by-desktop"), "keep");

  const prepared = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
    expectedWatchedSavePath: repo.watchedSavePath,
  });

  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.sourceStatus, "ready");
  await assert.rejects(stat(repo.repoPath));
  await assert.doesNotReject(stat(prepared.operation.destinationPath));
  assert.equal(
    await readFile(path.join(replacementPath, "owned-by-desktop"), "utf8"),
    "keep",
  );

  const result = await prepared.operation.resolve("commit");
  assert.equal(result.status, "committed");
  await assert.doesNotReject(stat(prepared.operation.destinationPath));
  const rebuilt = await rebuildSemanticReadModel({
    repoPath: prepared.operation.destinationPath,
  });
  assert.equal(rebuilt.observationCount, 1);
  const nextWatcher = await acquireSaveHistoryWatcher({
    repoPath: prepared.operation.destinationPath,
  });
  await nextWatcher.release();
  assert.deepEqual(
    await readFile(repo.watchedSavePath),
    await readFile(path.join(prepared.operation.destinationPath, "save.dat")),
  );
  const destinationExport = await readEncodedSave({
    repoPath: prepared.operation.destinationPath,
    access: "readOnly",
    commitRef: observed.observation.commit.ref,
  });
  assert.deepEqual(
    destinationExport.encodedBytes,
    await readFile(repo.watchedSavePath),
  );
});

test("repository replacement rolls back only its destination and refuses identity or watcher mismatches", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);

  const rejected = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
    expectedWatchedSavePath: path.join(
      repo.tempDirectory,
      "different-save.dat",
    ),
  });
  assert.deepEqual(rejected, {
    status: "rejected",
    reason: "differentWatchedSave",
    sourceStatus: "ready",
  });
  await assert.doesNotReject(stat(repo.repoPath));

  const watcher = await acquireSaveHistoryWatcher({ repoPath: repo.repoPath });
  const blocked = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
    expectedWatchedSavePath: repo.watchedSavePath,
  });
  assert.deepEqual(blocked, {
    status: "failed",
    reason: "watcherAlreadyAcquired",
    sourceStatus: "ready",
  });
  await watcher.release();

  const prepared = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
    expectedWatchedSavePath: repo.watchedSavePath,
  });
  assert.equal(prepared.status, "prepared");
  const rollback = await prepared.operation.resolve("rollback");
  assert.equal(rollback.status, "rolledBack");
  await assert.doesNotReject(stat(repo.repoPath));
  await assert.rejects(stat(prepared.operation.destinationPath));
});

test("repository replacement validates target placement", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);

  const invalidPlacement = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(repo.repoPath, "destinations", "history-repo-moved"),
    expectedWatchedSavePath: repo.watchedSavePath,
  });
  assert.deepEqual(invalidPlacement, {
    status: "rejected",
    reason: "invalidPlacement",
  });
  await assert.doesNotReject(stat(repo.repoPath));
});

test("repository replacement reports rollback failure and retains both discoverable locations", async (t) => {
  const repo = await createHistoryRepo(t);
  const destinationRoot = path.join(repo.tempDirectory, "destinations");
  await mkdir(destinationRoot);
  const prepared = await prepareRepositoryReplacement({
    sourcePath: repo.repoPath,
    targetPath: path.join(destinationRoot, "history-repo-moved"),
    expectedWatchedSavePath: repo.watchedSavePath,
  });
  assert.equal(prepared.status, "prepared");
  await mkdir(repo.repoPath);
  await writeFile(path.join(repo.repoPath, "replacement-populated"), "keep");

  const rollback = await prepared.operation.resolve("rollback");
  assert.equal(rollback.status, "rollbackFailed");
  await assert.doesNotReject(stat(repo.repoPath));
  await assert.doesNotReject(stat(prepared.operation.destinationPath));
  assert.equal(
    await readFile(path.join(repo.repoPath, "replacement-populated"), "utf8"),
    "keep",
  );
});

test("Git integrity warnings do not block a verified repository snapshot or migration", async (t) => {
  const repo = await createHistoryRepo(t);
  const observed = await observeSave({ repoPath: repo.repoPath });
  assert.equal(observed.status, "committed");
  await corruptUnreachableGitObject(repo.repoPath);
  await setRepositoryFormatVersion(repo, undefined);

  const strictInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  assert.equal(strictInspection.status, "invalid");
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
    gitIntegrityPolicy: "advisory",
  });
  assert.equal(inspection.status, "legacyConfig");
  const prepared = await prepareSaveHistoryMigration({
    snapshotPath: path.join(repo.tempDirectory, "snapshots", "corrupt-git"),
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });

  assert.equal(prepared.status, "prepared");
  const warning = prepared.operation.snapshot.gitIntegrityWarning;
  if (typeof warning !== "string") {
    throw new TypeError("Expected a Git integrity warning.");
  }
  assert.match(warning, /Git integrity validation reported a problem/v);
  const migrated = await prepared.operation.commit();
  assert.equal(migrated.status, "migrated");
  assert.equal(migrated.sourceState, "migrated");
  assert.deepEqual(migrated.snapshotState, {
    repoPath: prepared.operation.snapshot.repoPath,
    status: "retained",
  });
});

test("migration preparation copies durable content and retains a published snapshot when commit is stale", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const snapshotPath = path.join(
    repo.tempDirectory,
    "snapshots",
    "opaque-target",
  );
  const prepared = await prepareSaveHistoryMigration({
    snapshotPath,
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });

  assert.equal(prepared.status, "prepared");
  const snapshotInspection = await inspectSaveHistoryRepository({
    repoPath: snapshotPath,
    gitIntegrityPolicy: "advisory",
  });
  assert.equal(snapshotInspection.status, "legacyConfig");

  const changedConfig = JSON.parse(await readFile(repo.configPath, "utf8")) as {
    capturePolicy: { debounceWriteMs: number };
  };
  changedConfig.capturePolicy.debounceWriteMs++;
  await writeFile(repo.configPath, `${JSON.stringify(changedConfig)}\n`);
  const migration = await prepared.operation.commit();

  assert.equal(migration.status, "rejected");
  assert.equal(migration.reason, "staleInspection");
  assert.equal(migration.sourceState, "unchanged");
  assert.deepEqual(migration.snapshotState, {
    repoPath: prepared.operation.snapshot.repoPath,
    status: "retained",
  });
  const retainedSnapshot = await stat(prepared.operation.snapshot.repoPath);
  assert.ok(retainedSnapshot.isDirectory());
});

test("migration preparation failure does not change the source", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersion(repo, undefined);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const result = await prepareSaveHistoryMigration({
    snapshotPath: path.join(repo.repoPath, "snapshot-inside-source"),
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "snapshotFailed");
  const sourceInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  assert.equal(sourceInspection.status, "legacyConfig");

  const retryInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  const retry = await prepareSaveHistoryMigration({
    snapshotPath: path.join(repo.tempDirectory, "snapshot-after-failure"),
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: retryInspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  assert.equal(retry.status, "prepared");
  await retry.operation.release();
});

test("migration preparation refuses an externally owned watcher without changing the source", async (t) => {
  const repo = await createHistoryRepo(t);
  const watcher = await acquireSaveHistoryWatcher({ repoPath: repo.repoPath });
  t.after(async () => {
    await watcher.release();
  });
  await setRepositoryFormatVersion(repo, undefined);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });

  const result = await prepareSaveHistoryMigration({
    snapshotPath: path.join(repo.tempDirectory, "snapshot"),
    stagingRootPath: repo.stagingRootPath,
    repoPath: repo.repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "watcherAlreadyAcquired");
  const sourceInspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  assert.equal(sourceInspection.status, "legacyConfig");
});

test("newer incompatible repositories refuse reads and every public write workflow", async (t) => {
  const repo = await createHistoryRepo(t);
  const observation = await observeSave({ repoPath: repo.repoPath });
  assert.equal(observation.status, "committed");
  const rawBefore = await queryRawObservations({ repoPath: repo.repoPath });
  const restorePath = path.join(repo.tempDirectory, "restored.dat");

  await setRepositoryFormatVersion(repo, 2);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });
  assert.equal(inspection.status, "newerIncompatible");

  const assertIncompatible = (error: unknown) => {
    assert.ok(error instanceof SaveHistoryRepositoryIncompatibleError);
    assert.equal(error.status, "newerIncompatible");
    assert.deepEqual(error.capabilities, []);
    return true;
  };
  await assert.rejects(
    queryRawObservations({ repoPath: repo.repoPath }),
    assertIncompatible,
  );
  await assert.rejects(
    observeSave({ repoPath: repo.repoPath }),
    assertIncompatible,
  );
  await assert.rejects(
    rebuildSemanticReadModel({ repoPath: repo.repoPath }),
    assertIncompatible,
  );
  await assert.rejects(
    acquireSaveHistoryWatcher({ repoPath: repo.repoPath }),
    assertIncompatible,
  );
  await assert.rejects(
    restoreEncodedSave({
      repoPath: repo.repoPath,
      commitRef: observation.observation.commit.ref,
      target: { kind: "path", path: restorePath },
    }),
    assertIncompatible,
  );
  await assert.rejects(
    initSaveHistory({
      repoPath: repo.repoPath,
      watchedSavePath: repo.watchedSavePath,
    }),
    assertIncompatible,
  );
  await setRepositoryFormatVersion(repo, 1);
  const rawAfter = await queryRawObservations({ repoPath: repo.repoPath });
  assert.deepEqual(rawAfter, rawBefore);
});

test("observeSave commits a recognized Raw Save Observation", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const observedAt = new Date("2026-06-30T12:00:00.000Z");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });

  const result = await observeSave({ repoPath, observedAt });

  assert.equal(result.status, "committed");
  assert.equal(result.observation.observedAt, observedAt.toISOString());
  assert.equal(result.observation.trigger, "watcher");
  assert.equal(result.observation.sourcePath, minimalEncodedSavePath);
  assert.match(result.observation.encodedSha256, /^[0-9a-f]{64}$/v);
  assert.match(result.observation.decodedSha256, /^[0-9a-f]{64}$/v);
  assert.equal(result.observation.decoderVersion, "silksong-save-decoder-v1");
  assert.equal(result.observation.schema.status, "recognized");
  assert.equal(result.observation.schema.saveSchemaVersion, "silksong-save-v1");
  assert.match(result.observation.commit.ref, /^[0-9a-f]{40}$/v);
  assert.match(result.observation.commit.shortRef, /^[0-9a-f]{7,12}$/v);
  assert.notEqual(result.observation.commit.committedAt, "");
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "save.dat")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "decoded-save.json")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "observation.json")),
  );
});

test("observeSave creates a queryable Semantic Read Model for a recognized observation", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
  assert.equal(result.semanticUpdate.status, "updated");
  assert.equal(result.semanticUpdate.eventCount, 0);

  const history = await queryHistory({ repoPath: repo.repoPath });
  const rawHistory = await queryRawObservations({ repoPath: repo.repoPath });

  assert.equal(history.events.length, 0);
  assert.equal(rawHistory.entries.length, 1);
  const [entry] = rawHistory.entries;

  assert.ok(entry !== undefined);
  assert.equal(entry.observation.commit.ref, result.observation.commit.ref);
  assert.ok(entry.snapshotSummary !== null);
  assert.equal(entry.snapshotSummary.completionPercentage, 39);
  assert.equal(entry.snapshotSummary.playTime, 87_137.12);
  assert.equal(entry.snapshotSummary.rosaries, 731);
  assert.equal(entry.snapshotSummary.shellShards, 76);
});

test("observeSave incrementally records Semantic Events for recognized observations", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const beforeResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const afterResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(beforeResult.status, "committed");
  assert.equal(afterResult.status, "committed");
  assert.equal(afterResult.semanticUpdate.status, "updated");
  assert.equal(afterResult.semanticUpdate.eventCount, 1);
  assert.equal(afterResult.semanticUpdate.events.length, 1);

  const history = await queryHistory({ repoPath: repo.repoPath });

  assert.equal(history.events.length, 1);
  const [event] = history.events;

  assert.ok(event !== undefined);
  assert.equal(event.commit.ref, afterResult.observation.commit.ref);
  assert.equal(event.previousCommit?.ref, beforeResult.observation.commit.ref);
  assert.equal(event.event.kind, "item");
  assert.equal(event.event.item.id, "mask-shard-2");
  assert.equal(event.event.after.status, "done");
  assert.deepEqual(afterResult.semanticUpdate.events[0], event);
});

test("observeSave incremental Semantic Read Model matches a full rebuild", async (t) => {
  const { repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);
  const incrementalHistory = await queryHistory({
    repoPath,
    includeFiltered: true,
  });
  const incrementalRawHistory = await queryRawObservations({ repoPath });

  await rebuildSemanticReadModel({ repoPath });

  const rebuiltHistory = await queryHistory({
    repoPath,
    includeFiltered: true,
  });
  const rebuiltRawHistory = await queryRawObservations({ repoPath });

  assert.deepEqual(rebuiltHistory, incrementalHistory);
  assert.deepEqual(rebuiltRawHistory, incrementalRawHistory);
});

test("observeSave records Unrecognized Schema Observations without interrupting recognized diffs", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const recognizedBefore = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  await copyFile(unrecognizedEncodedSavePath, repo.watchedSavePath);
  const unrecognized = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const recognizedAfter = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  assert.equal(recognizedBefore.status, "committed");
  assert.equal(unrecognized.status, "committed");
  assert.equal(unrecognized.semanticUpdate.status, "notAvailable");
  assert.equal(unrecognized.semanticUpdate.reason, "unrecognizedSchema");
  assert.equal(recognizedAfter.status, "committed");
  assert.equal(recognizedAfter.semanticUpdate.status, "updated");
  assert.equal(recognizedAfter.semanticUpdate.eventCount, 1);

  const history = await queryHistory({ repoPath: repo.repoPath });
  const rawHistory = await queryRawObservations({ repoPath: repo.repoPath });

  assert.equal(history.events.length, 1);
  const [event] = history.events;

  assert.ok(event !== undefined);
  assert.equal(event.commit.ref, recognizedAfter.observation.commit.ref);
  assert.ok(event.previousCommit !== undefined);
  assert.equal(
    event.previousCommit.ref,
    recognizedBefore.observation.commit.ref,
  );
  assert.equal(rawHistory.entries.length, 3);
  const [, rawUnrecognizedEntry] = rawHistory.entries;

  assert.ok(rawUnrecognizedEntry !== undefined);
  assert.equal(
    rawUnrecognizedEntry.observation.commit.ref,
    unrecognized.observation.commit.ref,
  );
  assert.equal(rawUnrecognizedEntry.observation.schema.status, "unrecognized");
  // The public contract uses explicit null for observations without a Semantic Snapshot.
  // eslint-disable-next-line unicorn/no-null
  assert.equal(rawUnrecognizedEntry.snapshotSummary, null);
});

test("observeSave requires an explicit rebuild when the Semantic Read Model is missing", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const beforeResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(beforeResult.status, "committed");

  await removeSemanticReadModelFixture(repo);
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const inspection = await inspectSaveHistoryRepository({
    repoPath: repo.repoPath,
  });

  assert.equal(inspection.status, "rebuildRequired");
  await assert.rejects(
    observeSave({
      repoPath: repo.repoPath,
      observedAt: new Date("2026-06-30T12:01:00.000Z"),
    }),
  );
  await rebuildSemanticReadModel({ repoPath: repo.repoPath });
  const afterResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(afterResult.status, "committed");
  assert.equal(afterResult.semanticUpdate.status, "updated");
  assert.equal(afterResult.semanticUpdate.eventCount, 1);

  const history = await queryHistory({ repoPath: repo.repoPath });
  const rawHistory = await queryRawObservations({ repoPath: repo.repoPath });

  assert.equal(history.events.length, 1);
  const [event] = history.events;

  assert.ok(event !== undefined);
  assert.equal(event.commit.ref, afterResult.observation.commit.ref);
  assert.ok(event.previousCommit !== undefined);
  assert.equal(event.previousCommit.ref, beforeResult.observation.commit.ref);
  assert.equal(rawHistory.entries.length, 2);
});

test("restoreEncodedSave writes the observed Encoded Save byte-for-byte", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const restorePath = path.join(tempDirectory, "restored-save.dat");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const observationResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observationResult.status, "committed");

  const restoreResult = await restoreEncodedSave({
    repoPath,
    commitRef: observationResult.observation.commit.ref,
    target: {
      kind: "path",
      path: restorePath,
    },
  });

  assert.equal(restoreResult.targetPath, restorePath);
  assert.equal(
    restoreResult.commit.ref,
    observationResult.observation.commit.ref,
  );
  assert.equal(
    restoreResult.writtenSha256,
    observationResult.observation.encodedSha256,
  );
  assert.deepEqual(
    await readFile(restorePath),
    await readFile(minimalEncodedSavePath),
  );
});

test("getSaveState returns empty before the first Raw Save Observation", async (t) => {
  const repo = await createHistoryRepo(t);

  assert.deepEqual(
    await getSaveState({
      repoPath: repo.repoPath,
      selector: { kind: "latest" },
    }),
    { status: "empty" },
  );
});

test("preflightInPlaceRestore distinguishes history and Watched Save states", async (t) => {
  const repo = await createHistoryRepo(t);

  assert.deepEqual(await preflightInPlaceRestore({ repoPath: repo.repoPath }), {
    status: "emptyHistory",
  });

  const observation = await observeSave({ repoPath: repo.repoPath });
  assert.equal(observation.status, "committed");

  assert.deepEqual(await preflightInPlaceRestore({ repoPath: repo.repoPath }), {
    status: "targetPresent",
    expectedCurrent: {
      status: "present",
      encodedSha256: observation.observation.encodedSha256,
    },
  });

  await rm(repo.watchedSavePath);
  assert.deepEqual(await preflightInPlaceRestore({ repoPath: repo.repoPath }), {
    status: "targetMissing",
    expectedCurrent: { status: "missing" },
  });

  await mkdir(repo.watchedSavePath);
  await assert.rejects(
    preflightInPlaceRestore({ repoPath: repo.repoPath }),
    WatchedSaveUnavailableError,
  );
});

test("getSaveState reads latest and explicit immutable observation state", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
  ]);
  const [first, second] = observations;

  assert.ok(first !== undefined);
  assert.ok(second !== undefined);

  const latest = await getSaveState({
    repoPath,
    selector: { kind: "latest" },
  });
  const explicit = await getSaveState({
    repoPath,
    selector: { kind: "commit", commitRef: first.observation.commit.ref },
  });

  assert.equal(latest.status, "available");
  assert.equal(explicit.status, "available");
  assert.equal(latest.observation.commit.ref, second.observation.commit.ref);
  assert.equal(explicit.observation.commit.ref, first.observation.commit.ref);
  assert.equal(
    latest.semanticSnapshot?.items.find((item) => item.id === "mask-shard-2")
      ?.status,
    "done",
  );
  assert.equal(
    explicit.semanticSnapshot?.items.find((item) => item.id === "mask-shard-2")
      ?.status,
    "missing",
  );
});

test("getSaveState keeps unrecognized Decoded Save inspectable and reports missing recognized snapshots", async (t) => {
  const unrecognizedRepo = await createHistoryRepo(
    t,
    unrecognizedEncodedSavePath,
  );
  const unrecognizedObservation = await observeSave({
    repoPath: unrecognizedRepo.repoPath,
  });

  assert.equal(unrecognizedObservation.status, "committed");
  const unrecognizedState = await getSaveState({
    repoPath: unrecognizedRepo.repoPath,
    selector: { kind: "latest" },
  });

  assert.equal(unrecognizedState.status, "available");
  assert.equal(unrecognizedState.observation.schema.status, "unrecognized");
  // The public state contract uses explicit null for an unrecognized schema.
  // eslint-disable-next-line unicorn/no-null
  assert.equal(unrecognizedState.semanticSnapshot, null);
  assert.equal(typeof unrecognizedState.decodedSave, "object");

  const recognizedRepo = await createHistoryRepo(t);
  await observeSave({ repoPath: recognizedRepo.repoPath });
  await removeSemanticReadModelFixture(recognizedRepo);

  await assert.rejects(
    getSaveState({
      repoPath: recognizedRepo.repoPath,
      selector: { kind: "latest" },
    }),
    SaveHistoryRepositoryIncompatibleError,
  );
});

test("readEncodedSave returns exact committed bytes with a safe suggested filename", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "存档 slot.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  const result = await observeSave({ repoPath });

  assert.equal(result.status, "committed");

  const exported = await readEncodedSave({
    repoPath,
    commitRef: result.observation.commit.ref,
  });

  assert.deepEqual(
    exported.encodedBytes,
    await readFile(minimalEncodedSavePath),
  );
  assert.equal(exported.encodedSha256, result.observation.encodedSha256);
  assert.equal(exported.commit.ref, result.observation.commit.ref);
  assert.equal(
    exported.suggestedFileName,
    `存档-slot.${result.observation.commit.shortRef}.dat`,
  );
  assert.equal(exported.suggestedFileName.includes(tempDirectory), false);
});

test("observeSave skips an unchanged Encoded Save", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const firstResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const secondResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(secondResult.status, "skipped");
  assert.equal(secondResult.reason, "unchanged");
  assert.equal(
    secondResult.encodedSha256,
    firstResult.observation.encodedSha256,
  );
});

test("manual checkpoint skips an unchanged Encoded Save by default", async (t) => {
  const { repoPath } = await createHistoryRepo(t);

  const firstResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const checkpointResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
    trigger: "manualCheckpoint",
    message: "before risky operation",
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(checkpointResult.status, "skipped");
  assert.equal(checkpointResult.reason, "unchanged");
  assert.equal(
    checkpointResult.encodedSha256,
    firstResult.observation.encodedSha256,
  );
});

test("manual checkpoint can explicitly allow unchanged Encoded Save bytes", async (t) => {
  const { repoPath } = await createHistoryRepo(t);

  const firstResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const checkpointResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
    trigger: "manualCheckpoint",
    message: "before risky operation",
    allowUnchanged: true,
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(checkpointResult.status, "committed");
  assert.equal(checkpointResult.observation.trigger, "manualCheckpoint");
  assert.equal(checkpointResult.observation.message, "before risky operation");
  assert.equal(
    checkpointResult.observation.previousCommit,
    firstResult.observation.commit.ref,
  );
  assert.equal(
    checkpointResult.observation.encodedSha256,
    firstResult.observation.encodedSha256,
  );
  assert.notEqual(
    checkpointResult.observation.commit.ref,
    firstResult.observation.commit.ref,
  );
});

test("manual checkpoint bypasses the minimum commit interval", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      minCommitIntervalMs: 60 * 60 * 1000,
    },
  });

  const firstResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const skippedResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });
  const checkpointResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
    trigger: "manualCheckpoint",
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(skippedResult.status, "skipped");
  assert.equal(skippedResult.reason, "minimumCommitInterval");
  assert.equal(checkpointResult.status, "committed");
  assert.equal(checkpointResult.observation.trigger, "manualCheckpoint");
  assert.notEqual(
    checkpointResult.observation.encodedSha256,
    firstResult.observation.encodedSha256,
  );
});

test("observeSave reports the next allowed observation time for minimum interval skips", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      minCommitIntervalMs: 60 * 1000,
    },
  });

  const firstResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const skippedResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:10.000Z"),
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(skippedResult.status, "skipped");
  assert.equal(skippedResult.reason, "minimumCommitInterval");
  assert.equal(skippedResult.nextAllowedAt, "2026-06-30T12:01:00.000Z");
});

test("minimum commit interval can be disabled", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      minCommitIntervalMs: 0,
    },
  });

  const firstResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const secondResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:10.000Z"),
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(secondResult.status, "committed");
});

test("manual checkpoint reports decode failures without committing", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));
  await initSaveHistory({
    repoPath,
    watchedSavePath: invalidSavePath,
  });

  const result = await observeSave({
    repoPath,
    trigger: "manualCheckpoint",
  });

  assert.equal(result.status, "watcherError");
  assert.equal(result.error.reason, "decodeFailure");
  await assert.rejects(
    async () => await stat(path.join(repoPath, "observation.json")),
  );
});

test("history write lock serializes concurrent observations", async (t) => {
  const { repoPath } = await createHistoryRepo(t);

  const results = await Promise.all([
    observeSave({
      repoPath,
      observedAt: new Date("2026-06-30T12:00:00.000Z"),
    }),
    observeSave({
      repoPath,
      observedAt: new Date("2026-06-30T12:01:00.000Z"),
    }),
  ]);

  const committed = results.filter((result) => result.status === "committed");
  const skipped = results.filter((result) => result.status === "skipped");

  assert.equal(committed.length, 1);
  assert.equal(skipped.length, 1);
  const [skippedResult] = skipped;

  assert.ok(skippedResult !== undefined);
  assert.equal(skippedResult.status, "skipped");
  assert.equal(skippedResult.reason, "unchanged");
});

test("acquireSaveHistoryWatcher snapshots watcher configuration and observes with it", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      debounceWriteMs: 25,
      minCommitIntervalMs: 0,
    },
  });
  const alternateSavePath = path.join(repo.tempDirectory, "alternate-save.dat");
  const watcher = await acquireSaveHistoryWatcher({ repoPath: repo.repoPath });

  t.after(async () => {
    await watcher.release();
  });

  assert.equal(watcher.watchedSavePath, repo.watchedSavePath);
  assert.deepEqual(watcher.capturePolicy, {
    debounceWriteMs: 25,
    minCommitIntervalMs: 0,
  });
  assert.throws(() => {
    Object.assign(watcher.capturePolicy, { debounceWriteMs: 1000 });
  }, TypeError);

  await copyFile(minimalEncodedSavePath, alternateSavePath);
  const changedConfig = JSON.parse(await readFile(repo.configPath, "utf8")) as {
    watchedSavePath: string;
    capturePolicy: { debounceWriteMs: number; minCommitIntervalMs: number };
  };
  changedConfig.watchedSavePath = alternateSavePath;
  changedConfig.capturePolicy = {
    debounceWriteMs: 1000,
    minCommitIntervalMs: 60_000,
  };
  await writeFile(repo.configPath, `${JSON.stringify(changedConfig)}\n`);
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);

  const watcherResult = await watcher.observe({
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(watcherResult.status, "committed");
  assert.equal(watcherResult.observation.sourcePath, repo.watchedSavePath);
  assert.deepEqual(watcher.capturePolicy, {
    debounceWriteMs: 25,
    minCommitIntervalMs: 0,
  });

  const manualResult = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
    trigger: "manualCheckpoint",
  });

  assert.equal(manualResult.status, "committed");
  assert.equal(manualResult.observation.sourcePath, alternateSavePath);
});

test("Save History Watcher preserves observation outcomes and releases ownership safely", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { minCommitIntervalMs: 60_000 },
  });
  const watcher = await acquireSaveHistoryWatcher({
    repoPath: repo.repoPath,
    startedAt: new Date("2026-06-30T11:59:00.000Z"),
  });

  const first = await watcher.observe({
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  assert.equal(first.status, "committed");

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const deferred = await watcher.observe({
    observedAt: new Date("2026-06-30T12:00:10.000Z"),
  });
  assert.deepEqual(deferred, {
    status: "skipped",
    reason: "minimumCommitInterval",
    encodedSha256: createHash("sha256")
      .update(await readFile(repo.watchedSavePath))
      .digest("hex"),
    nextAllowedAt: "2026-06-30T12:01:00.000Z",
  });

  const deferredObservation = watcher.observe({
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });
  const release = watcher.release();
  await assert.rejects(
    watcher.observe({ observedAt: new Date("2026-06-30T12:02:00.000Z") }),
    /Save History Watcher is closing/v,
  );
  await assert.rejects(
    acquireSaveHistoryWatcher({ repoPath: repo.repoPath }),
    (error: unknown) => {
      assert.ok(error instanceof SaveHistoryWatcherAlreadyAcquiredError);
      assert.equal(error.lockInfo?.startedAt, "2026-06-30T11:59:00.000Z");

      return true;
    },
  );

  const committedDeferredObservation = await deferredObservation;
  assert.equal(committedDeferredObservation.status, "committed");
  await Promise.all([release, watcher.release()]);

  await writeFile(repo.watchedSavePath, new Uint8Array([1, 2, 3, 4]));
  const nextWatcher = await acquireSaveHistoryWatcher({
    repoPath: repo.repoPath,
  });
  t.after(async () => {
    await nextWatcher.release();
  });
  const watcherError = await nextWatcher.observe({
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  assert.equal(watcherError.status, "watcherError");
  assert.equal(watcherError.error.reason, "decodeFailure");
});

test("observeSave reports decode failures as Watcher Errors without committing", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));
  await initSaveHistory({
    repoPath,
    watchedSavePath: invalidSavePath,
  });

  const result = await observeSave({ repoPath });

  assert.equal(result.status, "watcherError");
  assert.equal(result.error.reason, "decodeFailure");
  await assert.rejects(
    async () => await stat(path.join(repoPath, "observation.json")),
  );
});

test("observeSave commits an Unrecognized Schema Observation without semantic update", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const unrecognizedSavePath = path.join(
    tempDirectory,
    "unrecognized-save.dat",
  );
  const restorePath = path.join(tempDirectory, "restored-unrecognized.dat");

  await copyFile(unrecognizedEncodedSavePath, unrecognizedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath: unrecognizedSavePath,
  });

  const result = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
  assert.equal(result.observation.schema.status, "unrecognized");
  assert.notEqual(result.observation.schema.reason, "");
  assert.equal(result.semanticUpdate.status, "notAvailable");
  assert.equal(result.semanticUpdate.reason, "unrecognizedSchema");
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "save.dat")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "decoded-save.json")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "observation.json")),
  );

  const restoreResult = await restoreEncodedSave({
    repoPath,
    commitRef: result.observation.commit.ref,
    target: {
      kind: "path",
      path: restorePath,
    },
  });

  assert.equal(restoreResult.writtenSha256, result.observation.encodedSha256);
  assert.deepEqual(
    await readFile(restorePath),
    await readFile(unrecognizedSavePath),
  );
});

test("restoreEncodedSave refuses to overwrite an existing target implicitly", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const restorePath = path.join(tempDirectory, "existing-save.dat");
  const existingBytes = new Uint8Array([9, 8, 7, 6]);

  await writeFile(restorePath, existingBytes);
  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const observationResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observationResult.status, "committed");

  await assert.rejects(
    async () =>
      await restoreEncodedSave({
        repoPath,
        commitRef: observationResult.observation.commit.ref,
        target: {
          kind: "path",
          path: restorePath,
        },
      }),
    RestoreTargetExistsError,
  );
  assert.deepEqual(await readFile(restorePath), Buffer.from(existingBytes));
});

test("restoreEncodedSave creates a backup before in-place restore", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const firstObservation = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(firstObservation.status, "committed");

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const beforeRestoreBytes = await readFile(repo.watchedSavePath);
  const restoreResult = await restoreEncodedSave({
    repoPath: repo.repoPath,
    commitRef: firstObservation.observation.commit.ref,
    now: new Date("2026-07-02T14:30:12.000Z"),
    target: {
      kind: "inPlace",
      confirmation: "restore-watched-save",
    },
  });

  const expectedBackupPath = path.join(
    repo.tempDirectory,
    "watched-save.dat.before-restore.20260702T143012Z.dat",
  );

  assert.equal(restoreResult.targetPath, repo.watchedSavePath);
  assert.equal(restoreResult.backupPath, expectedBackupPath);
  assert.deepEqual(await readFile(expectedBackupPath), beforeRestoreBytes);
  assert.deepEqual(
    await readFile(repo.watchedSavePath),
    await readFile(minimalEncodedSavePath),
  );
});

test("restoreEncodedSave rejects a stale in-place precondition before backup or write", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const observation = await observeSave({ repoPath: repo.repoPath });
  const before = await readFile(repo.watchedSavePath);

  assert.equal(observation.status, "committed");

  await assert.rejects(
    restoreEncodedSave({
      repoPath: repo.repoPath,
      commitRef: observation.observation.commit.ref,
      target: {
        kind: "inPlace",
        confirmation: "restore-watched-save",
        expectedCurrent: {
          status: "present",
          encodedSha256: "0".repeat(64),
        },
      },
    }),
    RestoreConflictError,
  );

  const after = await readFile(repo.watchedSavePath);
  const entries = await readdir(repo.tempDirectory);

  assert.deepEqual(after, before);
  assert.deepEqual(
    entries.filter((entry) => entry.includes("before-restore")),
    [],
  );
});

test("restoreEncodedSave restores in-place without backup when the watched save is missing", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const observation = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observation.status, "committed");

  await rm(repo.watchedSavePath);
  const restoreResult = await restoreEncodedSave({
    repoPath: repo.repoPath,
    commitRef: observation.observation.commit.ref,
    target: {
      kind: "inPlace",
      confirmation: "restore-watched-save",
    },
  });

  assert.equal(restoreResult.targetPath, repo.watchedSavePath);
  assert.equal(restoreResult.backupPath, undefined);
  assert.deepEqual(
    await readFile(repo.watchedSavePath),
    await readFile(minimalEncodedSavePath),
  );
});

test("restoreEncodedSave rejects relative in-place backup directories", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    restore: {
      backupDirectory: "relative-backups",
    },
  });
  const observation = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const beforeRestoreBytes = await readFile(repo.watchedSavePath);

  assert.equal(observation.status, "committed");

  await assert.rejects(
    async () =>
      await restoreEncodedSave({
        repoPath: repo.repoPath,
        commitRef: observation.observation.commit.ref,
        target: {
          kind: "inPlace",
          confirmation: "restore-watched-save",
        },
      }),
    InvalidRestoreBackupDirectoryError,
  );
  assert.deepEqual(await readFile(repo.watchedSavePath), beforeRestoreBytes);
});

test("restoreEncodedSave retries colliding in-place backup names", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const observation = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const collidingBackupPath = path.join(
    repo.tempDirectory,
    "watched-save.dat.before-restore.20260702T143012Z.dat",
  );

  assert.equal(observation.status, "committed");

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await writeFile(collidingBackupPath, "existing backup");
  const restoreResult = await restoreEncodedSave({
    repoPath: repo.repoPath,
    commitRef: observation.observation.commit.ref,
    now: new Date("2026-07-02T14:30:12.000Z"),
    target: {
      kind: "inPlace",
      confirmation: "restore-watched-save",
    },
  });

  assert.equal(
    restoreResult.backupPath,
    path.join(
      repo.tempDirectory,
      "watched-save.dat.before-restore.20260702T143012Z.1.dat",
    ),
  );
  assert.equal(await readFile(collidingBackupPath, "utf8"), "existing backup");
});

test("restoreEncodedSave uses absolute target backup directories before in-place restore", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath);
  const backupDirectory = path.join(repo.tempDirectory, "backups");
  const observation = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observation.status, "committed");

  await mkdir(backupDirectory);
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const restoreResult = await restoreEncodedSave({
    repoPath: repo.repoPath,
    commitRef: observation.observation.commit.ref,
    now: new Date("2026-07-02T14:30:12.000Z"),
    target: {
      kind: "inPlace",
      confirmation: "restore-watched-save",
      backupDirectory,
    },
  });

  assert.equal(
    restoreResult.backupPath,
    path.join(
      backupDirectory,
      "watched-save.dat.before-restore.20260702T143012Z.dat",
    ),
  );
});

test("rebuildSemanticReadModel rebuilds recognized Semantic Events for queryHistory", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
  ]);
  const [beforeResult, afterResult] = observations;

  assert.ok(beforeResult !== undefined);
  assert.ok(afterResult !== undefined);

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const history = await queryHistory({ repoPath });

  assert.equal(rebuildResult.observationCount, 2);
  assert.equal(rebuildResult.recognizedObservationCount, 2);
  assert.equal(rebuildResult.unrecognizedObservationCount, 0);
  assert.equal(rebuildResult.snapshotCount, 2);
  assert.equal(rebuildResult.eventCount, 1);
  assert.equal(history.events.length, 1);

  const [historicalEvent] = history.events;

  assert.ok(historicalEvent !== undefined);
  assert.equal(historicalEvent.commit.ref, afterResult.observation.commit.ref);
  assert.equal(
    historicalEvent.previousCommit?.ref,
    beforeResult.observation.commit.ref,
  );
  assert.equal(
    historicalEvent.observation.commit.ref,
    afterResult.observation.commit.ref,
  );
  assert.equal(historicalEvent.event.kind, "item");
  assert.equal(historicalEvent.event.eventType, "itemStatusChanged");
  assert.equal(historicalEvent.event.item.id, "mask-shard-2");
  assert.equal(historicalEvent.event.after.status, "done");
  assert.equal(historicalEvent.snapshotSummary.completionPercentage, 39);
  assert.equal(historicalEvent.snapshotSummary.playTime, 87_137.12);
  assert.equal(historicalEvent.snapshotSummary.rosaries, 731);
  assert.equal(historicalEvent.snapshotSummary.shellShards, 76);
  assert.deepEqual(historicalEvent.visibility, {
    defaultVisible: true,
    filterReasons: [],
  });
});

test("rebuildSemanticReadModel preserves Unrecognized Schema Observations without Semantic Events", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    unrecognizedEncodedSavePath,
  ]);
  const [recognizedResult, unrecognizedResult] = observations;

  assert.ok(recognizedResult !== undefined);
  assert.ok(unrecognizedResult !== undefined);

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const history = await queryHistory({ repoPath });
  const rawHistory = await queryRawObservations({ repoPath });

  assert.equal(rebuildResult.observationCount, 2);
  assert.equal(rebuildResult.recognizedObservationCount, 1);
  assert.equal(rebuildResult.unrecognizedObservationCount, 1);
  assert.equal(rebuildResult.snapshotCount, 1);
  assert.equal(rebuildResult.eventCount, 0);
  assert.equal(history.events.length, 0);
  assert.equal(rawHistory.entries.length, 2);
  const [recognizedEntry, unrecognizedEntry] = rawHistory.entries;

  assert.ok(recognizedEntry !== undefined);
  assert.ok(unrecognizedEntry !== undefined);
  assert.equal(recognizedEntry.observation.schema.status, "recognized");
  assert.equal(unrecognizedEntry.observation.schema.status, "unrecognized");
  assert.equal(
    unrecognizedEntry.observation.commit.ref,
    unrecognizedResult.observation.commit.ref,
  );
});

test("queryRawObservations paginates independently in both orders", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);
  const [firstObservation, , thirdObservation] = observations;

  assert.ok(firstObservation !== undefined);
  assert.ok(thirdObservation !== undefined);

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const firstPage = await queryHistory({
    repoPath,
    includeFiltered: true,
    limit: 1,
  });

  assert.equal(rebuildResult.eventCount, 2);
  assert.equal(firstPage.events.length, 1);
  assert.equal("rawObservations" in firstPage, false);
  assert.notEqual(firstPage.nextCursor, undefined);

  const secondPage = await queryHistory({
    repoPath,
    includeFiltered: true,
    limit: 1,
    cursor: firstPage.nextCursor,
  });

  assert.equal(secondPage.events.length, 1);
  assert.notEqual(secondPage.events[0]?.id, firstPage.events[0]?.id);
  assert.equal(secondPage.nextCursor, undefined);

  const firstRawPage = await queryRawObservations({
    repoPath,
    limit: 1,
    order: "desc",
  });

  assert.equal(firstRawPage.entries.length, 1);
  assert.equal(
    firstRawPage.entries[0]?.observation.commit.ref,
    thirdObservation.observation.commit.ref,
  );
  assert.notEqual(firstRawPage.nextCursor, undefined);

  const secondRawPage = await queryRawObservations({
    repoPath,
    limit: 2,
    cursor: firstRawPage.nextCursor,
    order: "desc",
  });

  assert.equal(secondRawPage.entries.length, 2);
  assert.equal(
    secondRawPage.entries[1]?.observation.commit.ref,
    firstObservation.observation.commit.ref,
  );
});

test("diffCommits returns Semantic Snapshots and Historical Semantic Events", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
  ]);
  const [beforeResult, afterResult] = observations;

  assert.ok(beforeResult !== undefined);
  assert.ok(afterResult !== undefined);

  await rebuildSemanticReadModel({ repoPath });
  const diff = await diffCommits({
    repoPath,
    fromRef: beforeResult.observation.commit.ref,
    toRef: afterResult.observation.commit.ref,
  });

  assert.equal(diff.from.ref, beforeResult.observation.commit.ref);
  assert.equal(diff.to.ref, afterResult.observation.commit.ref);
  assert.equal(diff.before.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(diff.after.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(diff.events.length, 1);
  const [event] = diff.events;

  assert.ok(event !== undefined);
  assert.equal(event.commit.ref, afterResult.observation.commit.ref);
  assert.equal(event.previousCommit?.ref, beforeResult.observation.commit.ref);
  assert.deepEqual(event.snapshotSummary, diff.after.summary);
  assert.equal(event.event.kind, "item");
});

test("diffCommits applies Display Semantic Event Filters by default", async (t) => {
  const { observations, repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);
  const [, visibleBaseline, filteredChange] = observations;

  assert.ok(visibleBaseline !== undefined);
  assert.ok(filteredChange !== undefined);

  await rebuildSemanticReadModel({ repoPath });
  const defaultDiff = await diffCommits({
    repoPath,
    fromRef: visibleBaseline.observation.commit.ref,
    toRef: filteredChange.observation.commit.ref,
  });
  const completeDiff = await diffCommits({
    repoPath,
    fromRef: visibleBaseline.observation.commit.ref,
    toRef: filteredChange.observation.commit.ref,
    includeFiltered: true,
  });

  assert.equal(defaultDiff.events.length, 0);
  assert.equal(completeDiff.events.length, 1);
  const [hiddenEvent] = completeDiff.events;

  assert.ok(hiddenEvent !== undefined);
  assert.equal(hiddenEvent.event.kind, "summaryMetric");
  assert.equal(hiddenEvent.visibility.defaultVisible, false);
  assert.deepEqual(hiddenEvent.visibility.filterReasons, [
    "summaryMetric:rosaries",
  ]);
});

test("searchSemanticEvents finds events by structured fields", async (t) => {
  const { repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);

  await rebuildSemanticReadModel({ repoPath });

  const itemSearch = await searchSemanticEvents({
    repoPath,
    query: {
      itemId: "mask-shard-2",
      statusTo: "done",
    },
  });
  const summarySearch = await searchSemanticEvents({
    repoPath,
    query: {
      eventType: "summaryMetricChanged",
    },
    includeFiltered: true,
  });

  assert.equal(itemSearch.events.length, 1);
  const [itemEvent] = itemSearch.events;

  assert.ok(itemEvent !== undefined);
  assert.equal(itemEvent.event.kind, "item");
  assert.equal(itemEvent.snapshotSummary.rosaries, 731);
  assert.equal(summarySearch.events.length, 1);
  const [summaryEvent] = summarySearch.events;

  assert.ok(summaryEvent !== undefined);
  assert.equal(summaryEvent.event.kind, "summaryMetric");
  assert.equal(summaryEvent.event.direction, "progression");
});

test("searchSemanticEvents paginates a stable descending query with an opaque cursor", async (t) => {
  const { repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);

  await rebuildSemanticReadModel({ repoPath });

  const firstPage = await searchSemanticEvents({
    repoPath,
    query: {},
    includeFiltered: true,
    limit: 1,
    order: "desc",
  });

  assert.equal(firstPage.events.length, 1);
  assert.notEqual(firstPage.nextCursor, undefined);

  const secondPage = await searchSemanticEvents({
    repoPath,
    query: {},
    includeFiltered: true,
    limit: 1,
    cursor: firstPage.nextCursor,
    order: "desc",
  });

  assert.equal(secondPage.events.length, 1);
  assert.notEqual(secondPage.events[0]?.id, firstPage.events[0]?.id);
  assert.equal(secondPage.nextCursor, undefined);
  const [firstEvent] = firstPage.events;
  const [secondEvent] = secondPage.events;

  assert.ok(firstEvent !== undefined);
  assert.ok(secondEvent !== undefined);
  assert.ok(
    firstEvent.observation.observedAt > secondEvent.observation.observedAt,
  );

  await assert.rejects(
    searchSemanticEvents({
      repoPath,
      query: { text: "different" },
      includeFiltered: true,
      limit: 1,
      cursor: firstPage.nextCursor,
      order: "desc",
    }),
  );
});

test("searchSemanticEvents finds events by free text", async (t) => {
  const { repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);

  await rebuildSemanticReadModel({ repoPath });

  const maskShardSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "Mask Shard",
    },
  });
  const rosariesSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "rosaries",
    },
    includeFiltered: true,
  });
  const unrelatedSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "definitely not present",
    },
  });

  assert.equal(maskShardSearch.events.length, 1);
  assert.equal(maskShardSearch.events[0]?.event.kind, "item");
  assert.equal(rosariesSearch.events.length, 1);
  assert.equal(rosariesSearch.events[0]?.event.kind, "summaryMetric");
  assert.equal(unrelatedSearch.events.length, 0);
});

test("queryHistory applies Display Semantic Event Filters at query time", async (t) => {
  const { repoPath } = await observeFixtureSequence(t, [
    minimalEncodedSavePath,
    maskShard2CollectedEncodedSavePath,
    maskShard2CollectedRosariesEncodedSavePath,
  ]);

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const defaultHistory = await queryHistory({ repoPath });
  const completeHistory = await queryHistory({
    repoPath,
    includeFiltered: true,
  });

  assert.equal(rebuildResult.eventCount, 2);
  assert.equal(defaultHistory.events.length, 1);
  const [defaultEvent] = defaultHistory.events;

  assert.ok(defaultEvent !== undefined);
  assert.equal(defaultEvent.event.kind, "item");
  assert.equal(defaultEvent.visibility.defaultVisible, true);
  assert.equal(completeHistory.events.length, 2);

  const hiddenSummaryEvent = completeHistory.events.find(
    (event) => event.event.kind === "summaryMetric",
  );

  assert.ok(hiddenSummaryEvent !== undefined);
  assert.equal(hiddenSummaryEvent.visibility.defaultVisible, false);
  assert.deepEqual(hiddenSummaryEvent.visibility.filterReasons, [
    "summaryMetric:rosaries",
  ]);
});
