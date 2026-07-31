import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { setRepositoryFormatVersionFixture } from "./repository-test-fixtures.ts";
import type { InProcessCliResult } from "./test-harness.ts";
import { runCliInProcess } from "./test-harness.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureDirectory = path.join(
  repoRoot,
  "packages/core/src/decode/fixtures",
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

interface CliHistoryRepoFixture {
  readonly tempDirectory: string;
  readonly watchedSavePath: string;
  readonly repoPath: string;
}

async function runCli(args: readonly string[]): Promise<InProcessCliResult> {
  return await runCliInProcess(args);
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "silksong-cli-test-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function createCliHistoryRepo(
  t: TestContext,
  initialSavePath = minimalEncodedSavePath,
): Promise<CliHistoryRepoFixture> {
  const tempDirectory = await createTempDirectory(t);
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");
  const repoPath = path.join(tempDirectory, "history-repo");

  await writeFile(watchedSavePath, await readFile(initialSavePath));
  const initResult = await runCli([
    "repo",
    "init",
    "--save",
    watchedSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(initResult.exitCode, 0);
  assert.equal(initResult.stderr, "");

  return {
    tempDirectory,
    watchedSavePath,
    repoPath,
  };
}

async function removeSemanticReadModelFixture(repo: CliHistoryRepoFixture) {
  // Fixture construction only: public CLI behavior deliberately offers no operation that corrupts
  // or removes a derived Semantic Read Model.
  await rm(path.join(repo.repoPath, ".silksong-git/read-model.sqlite"));
}

async function removeManagedGitRepositoryFixture(repo: CliHistoryRepoFixture) {
  // Fixture construction only: the public CLI intentionally offers no operation that corrupts a
  // managed Git repository.
  await rm(path.join(repo.repoPath, ".git"), { recursive: true, force: true });
}

function parseStdoutJson(result: InProcessCliResult): unknown {
  return JSON.parse(result.stdout) as unknown;
}

function parseRestoreOutputLine(output: string, key: string): string {
  const prefix = `${key}: `;
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));

  assert.ok(line !== undefined);

  return line.slice(prefix.length);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

test("repo init creates a Save History Repository with JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    minimalEncodedSavePath,
    "--repo",
    repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const initResult = parseStdoutJson(result) as {
    readonly repoPath?: unknown;
    readonly configPath?: unknown;
  };

  assert.equal(initResult.repoPath, repoPath);
  assert.equal(
    initResult.configPath,
    path.join(repoPath, ".silksong-git/config.json"),
  );
  const config = (await readJsonFile(initResult.configPath)) as {
    readonly watchedSavePath?: unknown;
  };

  assert.equal(config.watchedSavePath, minimalEncodedSavePath);
});

test("repo init refuses an invalid Watched Save path", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const missingSavePath = path.join(tempDirectory, "missing-save.dat");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    missingSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /save path must be readable/v);
});

test("repo init refuses a non-empty repository directory", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  await mkdir(repoPath);
  await writeFile(path.join(repoPath, ".gitkeep"), "");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    minimalEncodedSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /repository path must be empty/v);
});

test("repo inspect reports every safe compatibility status and exit code", async (t) => {
  const readyRepo = await createCliHistoryRepo(t);
  const rebuildRepo = await createCliHistoryRepo(t);
  await removeSemanticReadModelFixture(rebuildRepo);
  const legacyRepo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(legacyRepo.repoPath, undefined);
  const migrationRepo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(migrationRepo.repoPath, 0);
  const newerRepo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(newerRepo.repoPath, 2);
  const invalidRepo = await createCliHistoryRepo(t);
  await removeManagedGitRepositoryFixture(invalidRepo);

  const cases = [
    {
      repoPath: readyRepo.repoPath,
      exitCode: 0,
      inspection: {
        status: "ready",
        requiredAction: "open",
        capabilities: [
          "read",
          "observe",
          "restore",
          "rebuildReadModel",
          "watch",
        ],
      },
    },
    {
      repoPath: rebuildRepo.repoPath,
      exitCode: 5,
      inspection: {
        status: "rebuildRequired",
        requiredAction: "rebuildReadModel",
        capabilities: ["rebuildReadModel"],
      },
    },
    {
      repoPath: legacyRepo.repoPath,
      exitCode: 5,
      inspection: {
        status: "legacyConfig",
        requiredAction: "confirmMigration",
        capabilities: [],
      },
    },
    {
      repoPath: migrationRepo.repoPath,
      exitCode: 5,
      inspection: {
        status: "migrationRequired",
        requiredAction: "confirmMigration",
        capabilities: [],
      },
    },
    {
      repoPath: newerRepo.repoPath,
      exitCode: 5,
      inspection: {
        status: "newerIncompatible",
        requiredAction: "useNewerApp",
        capabilities: [],
      },
    },
    {
      repoPath: invalidRepo.repoPath,
      exitCode: 5,
      inspection: {
        status: "invalid",
        requiredAction: "chooseAnotherDirectory",
        capabilities: [],
      },
    },
  ] as const;

  for (const { repoPath, exitCode, inspection: expectedInspection } of cases) {
    const result = await runCli([
      "repo",
      "inspect",
      "--repo",
      repoPath,
      "--json",
    ]);

    assert.equal(result.exitCode, exitCode);
    assert.equal(result.stderr, "");
    const inspection = parseStdoutJson(result) as Record<string, unknown>;

    assert.deepEqual(inspection, expectedInspection);
    assert.equal("inspectionId" in inspection, false);
  }
});

test("repo migrate requires explicit confirmation", async (t) => {
  const repo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo.repoPath, undefined);

  const result = await runCli(["repo", "migrate", "--repo", repo.repoPath]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /migration requires --confirm-migration/v);
});

test("repo migrate performs inspection and migration in one command", async (t) => {
  const repo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo.repoPath, undefined);

  const result = await runCli([
    "repo",
    "migrate",
    "--repo",
    repo.repoPath,
    "--confirm-migration",
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const migration = parseStdoutJson(result) as {
    readonly status?: unknown;
    readonly backupCreated?: unknown;
    readonly inspection?: Record<string, unknown>;
  };

  assert.equal(migration.status, "migrated");
  assert.equal(migration.backupCreated, true);
  assert.deepEqual(migration.inspection, {
    status: "ready",
    requiredAction: "open",
    capabilities: ["read", "observe", "restore", "rebuildReadModel", "watch"],
  });
  assert.equal("inspectionId" in (migration.inspection ?? {}), false);
});

test("repo migrate safely guides read-model rebuild and newer incompatible repositories", async (t) => {
  const rebuildRepo = await createCliHistoryRepo(t);
  await removeSemanticReadModelFixture(rebuildRepo);
  const newerRepo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(newerRepo.repoPath, 2);

  const rebuildResult = await runCli([
    "repo",
    "migrate",
    "--repo",
    rebuildRepo.repoPath,
    "--confirm-migration",
  ]);
  const newerResult = await runCli([
    "repo",
    "migrate",
    "--repo",
    newerRepo.repoPath,
    "--confirm-migration",
  ]);

  assert.equal(rebuildResult.exitCode, 5);
  assert.match(rebuildResult.stdout, /migration rejected/v);
  assert.match(rebuildResult.stdout, /history rebuild/v);
  assert.equal(newerResult.exitCode, 5);
  assert.match(newerResult.stdout, /migration rejected/v);
  assert.match(newerResult.stdout, /update Silksong Git/v);
});

test("watch start validates HTTP option combinations and port syntax", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);
  const malformedResult = await runCli([
    "watch",
    "start",
    "--repo",
    repoPath,
    "--http",
    "--port",
    "nope",
  ]);
  const portResult = await runCli([
    "watch",
    "start",
    "--repo",
    repoPath,
    "--port",
    "43117",
  ]);

  assert.equal(malformedResult.exitCode, 1);
  assert.equal(malformedResult.stdout, "");
  assert.match(malformedResult.stderr, /integer from 1 to 65535/v);
  assert.equal(portResult.exitCode, 1);
  assert.equal(portResult.stdout, "");
  assert.match(portResult.stderr, /--port requires --http/v);
});

test("history checkpoint records a manual checkpoint with JSON output", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  const result = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--message",
    "before risky operation",
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const checkpointResult = parseStdoutJson(result) as {
    readonly status?: unknown;
    readonly observation?: {
      readonly trigger?: unknown;
      readonly message?: unknown;
      readonly commit?: { readonly ref?: unknown };
    };
  };

  assert.equal(checkpointResult.status, "committed");
  assert.ok(checkpointResult.observation !== undefined);
  assert.equal(checkpointResult.observation.trigger, "manualCheckpoint");
  assert.equal(checkpointResult.observation.message, "before risky operation");
  assert.match(
    String(checkpointResult.observation.commit?.ref),
    /^[0-9a-f]{40}$/v,
  );
});

test("history checkpoint prints newly added Semantic Events", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);

  await runCli(["history", "checkpoint", "--repo", repoPath]);
  await writeFile(
    watchedSavePath,
    await readFile(maskShard2CollectedEncodedSavePath),
  );
  const result = await runCli(["history", "checkpoint", "--repo", repoPath]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /checkpoint recorded/v);
  assert.match(result.stdout, /events: 1/v);
  assert.match(result.stdout, /- Mask Shard #2: missing -> done/v);
});

test("history checkpoint hints when unchanged bytes are skipped", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  await runCli(["history", "checkpoint", "--repo", repoPath]);

  const result = await runCli(["history", "checkpoint", "--repo", repoPath]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /unchanged/v);
  assert.match(result.stdout, /--allow-unchanged/v);
});

test("history checkpoint can explicitly record unchanged bytes", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);
  const firstResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const firstCheckpoint = parseStdoutJson(firstResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };

  const result = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--allow-unchanged",
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const checkpointResult = parseStdoutJson(result) as {
    readonly status?: unknown;
    readonly observation?: {
      readonly trigger?: unknown;
      readonly previousCommit?: unknown;
      readonly commit?: { readonly ref?: unknown };
    };
  };

  assert.equal(checkpointResult.status, "committed");
  assert.ok(checkpointResult.observation !== undefined);
  assert.ok(firstCheckpoint.observation !== undefined);
  assert.equal(checkpointResult.observation.trigger, "manualCheckpoint");
  assert.equal(
    checkpointResult.observation.previousCommit,
    firstCheckpoint.observation.commit?.ref,
  );
  assert.notEqual(
    checkpointResult.observation.commit?.ref,
    firstCheckpoint.observation.commit?.ref,
  );
});

test("history checkpoint maps decode failures to decode exit behavior", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");
  const repoPath = path.join(tempDirectory, "history-repo");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));
  await runCli(["repo", "init", "--save", invalidSavePath, "--repo", repoPath]);

  const result = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot decode save/v);
});

test("history rebuild succeeds for an empty repository", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  const result = await runCli([
    "history",
    "rebuild",
    "--repo",
    repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(parseStdoutJson(result), {
    observationCount: 0,
    recognizedObservationCount: 0,
    unrecognizedObservationCount: 0,
    snapshotCount: 0,
    eventCount: 0,
  });
});

test("history list prints Semantic Event history as JSON and text", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);

  await runCli(["history", "checkpoint", "--repo", repoPath]);
  await writeFile(
    watchedSavePath,
    await readFile(maskShard2CollectedEncodedSavePath),
  );
  await runCli(["history", "checkpoint", "--repo", repoPath]);
  const rebuildResult = await runCli([
    "history",
    "rebuild",
    "--repo",
    repoPath,
    "--json",
  ]);

  const result = await runCli([
    "history",
    "list",
    "--repo",
    repoPath,
    "--json",
  ]);
  const textResult = await runCli(["history", "list", "--repo", repoPath]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(textResult.exitCode, 0);
  assert.equal(textResult.stderr, "");
  assert.match(
    textResult.stdout,
    /^[0-9a-f]{7,12} Mask Shard #2: missing -> done$/mv,
  );
  assert.deepEqual(parseStdoutJson(rebuildResult), {
    observationCount: 2,
    recognizedObservationCount: 2,
    unrecognizedObservationCount: 0,
    snapshotCount: 2,
    eventCount: 1,
  });
  const history = parseStdoutJson(result) as {
    readonly events?: ReadonlyArray<{
      readonly event?: {
        readonly kind?: unknown;
        readonly item?: { readonly id?: unknown };
        readonly after?: { readonly status?: unknown };
      };
    }>;
  };

  assert.ok(history.events !== undefined);
  assert.equal(history.events.length, 1);
  const [historyEvent] = history.events;

  assert.ok(historyEvent !== undefined);
  assert.ok(historyEvent.event !== undefined);
  assert.ok(historyEvent.event.item !== undefined);
  assert.ok(historyEvent.event.after !== undefined);
  assert.equal(historyEvent.event.kind, "item");
  assert.equal(historyEvent.event.item.id, "mask-shard-2");
  assert.equal(historyEvent.event.after.status, "done");
});

test("history list validates pagination limit", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  const result = await runCli([
    "history",
    "list",
    "--repo",
    repoPath,
    "--limit",
    "0",
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /limit must be an integer from 1 to 1000/v);
});

test("history list guides a required Semantic Read Model rebuild", async (t) => {
  const repo = await createCliHistoryRepo(t);
  await removeSemanticReadModelFixture(repo);

  const result = await runCli([
    "history",
    "list",
    "--repo",
    repo.repoPath,
    "--json",
  ]);

  assert.match(result.stderr, /semantic read model unavailable/v);
  assert.match(result.stderr, /history rebuild/v);
  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, "");
});

test("history list directs legacy and older repository formats to CLI migration", async (t) => {
  for (const repositoryFormatVersion of [undefined, 0]) {
    const repo = await createCliHistoryRepo(t);
    await setRepositoryFormatVersionFixture(
      repo.repoPath,
      repositoryFormatVersion,
    );

    const result = await runCli([
      "history",
      "list",
      "--repo",
      repo.repoPath,
      "--json",
    ]);

    assert.equal(result.exitCode, 5);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /repository migration is required/v);
    assert.match(result.stderr, /repo migrate --repo .* --confirm-migration/v);
    assert.doesNotMatch(result.stderr, /history rebuild/v);
  }
});

test("history list directs newer repository formats to update Silksong Git", async (t) => {
  const repo = await createCliHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo.repoPath, 2);

  const result = await runCli([
    "history",
    "list",
    "--repo",
    repo.repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /newer Silksong Git version is required/v);
  assert.match(result.stderr, /update Silksong Git/v);
  assert.doesNotMatch(result.stderr, /migration|rebuild/v);
});

test("history list directs invalid repositories to choose another repository", async (t) => {
  const repo = await createCliHistoryRepo(t);
  await removeManagedGitRepositoryFixture(repo);

  const result = await runCli([
    "history",
    "list",
    "--repo",
    repo.repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 5);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /not a valid Save History Repository/v);
  assert.match(result.stderr, /choose another repository/v);
  assert.doesNotMatch(result.stderr, /migration|newer|rebuild/iv);
});

test("history search supports structured fields and event text", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);

  await runCli(["history", "checkpoint", "--repo", repoPath]);
  await writeFile(
    watchedSavePath,
    await readFile(maskShard2CollectedEncodedSavePath),
  );
  await runCli(["history", "checkpoint", "--repo", repoPath]);
  await runCli(["history", "rebuild", "--repo", repoPath]);

  const structuredResult = await runCli([
    "history",
    "search",
    "--repo",
    repoPath,
    "--item-id",
    "mask-shard-2",
    "--status-to",
    "done",
    "--json",
  ]);
  const textResult = await runCli([
    "history",
    "search",
    "--repo",
    repoPath,
    "--event",
    "Mask Shard",
    "--json",
  ]);
  const textOutputResult = await runCli([
    "history",
    "search",
    "--repo",
    repoPath,
    "--event",
    "Mask Shard",
  ]);

  assert.equal(structuredResult.exitCode, 0);
  assert.equal(textResult.exitCode, 0);
  assert.equal(textOutputResult.exitCode, 0);
  assert.equal(structuredResult.stderr, "");
  assert.equal(textResult.stderr, "");
  assert.equal(textOutputResult.stderr, "");
  assert.match(
    textOutputResult.stdout,
    /^[0-9a-f]{7,12} Mask Shard #2: missing -> done$/mv,
  );
  const structuredSearch = parseStdoutJson(structuredResult) as {
    readonly events?: readonly unknown[];
  };
  const textSearch = parseStdoutJson(textResult) as {
    readonly events?: readonly unknown[];
  };

  assert.equal(structuredSearch.events?.length, 1);
  assert.equal(textSearch.events?.length, 1);
});

test("history search validates query flags", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  const noQueryResult = await runCli(["history", "search", "--repo", repoPath]);
  const invalidEnumResult = await runCli([
    "history",
    "search",
    "--repo",
    repoPath,
    "--direction",
    "sideways",
  ]);

  assert.equal(noQueryResult.exitCode, 1);
  assert.equal(invalidEnumResult.exitCode, 1);
  assert.equal(noQueryResult.stdout, "");
  assert.equal(invalidEnumResult.stdout, "");
  assert.match(noQueryResult.stderr, /at least one query flag is required/v);
  assert.match(
    invalidEnumResult.stderr,
    /direction must be one of neutral, progression, regression/v,
  );
});

test("history diff prints Semantic Snapshot diff as JSON", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);

  const beforeResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  await writeFile(
    watchedSavePath,
    await readFile(maskShard2CollectedEncodedSavePath),
  );
  const afterResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const before = parseStdoutJson(beforeResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };
  const after = parseStdoutJson(afterResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };

  await runCli(["history", "rebuild", "--repo", repoPath]);
  const result = await runCli([
    "history",
    "diff",
    String(before.observation?.commit?.ref),
    String(after.observation?.commit?.ref),
    "--repo",
    repoPath,
    "--json",
  ]);
  const textResult = await runCli([
    "history",
    "diff",
    String(before.observation?.commit?.ref),
    String(after.observation?.commit?.ref),
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(textResult.exitCode, 0);
  assert.equal(textResult.stderr, "");
  assert.match(
    textResult.stdout,
    /^[0-9a-f]{7,12} Mask Shard #2: missing -> done$/mv,
  );
  const diff = parseStdoutJson(result) as {
    readonly from?: { readonly ref?: unknown };
    readonly to?: { readonly ref?: unknown };
    readonly events?: ReadonlyArray<{
      readonly event?: {
        readonly kind?: unknown;
        readonly item?: { readonly id?: unknown };
      };
    }>;
  };

  assert.ok(before.observation !== undefined);
  assert.ok(after.observation !== undefined);
  assert.ok(diff.events !== undefined);
  assert.equal(diff.from?.ref, before.observation.commit?.ref);
  assert.equal(diff.to?.ref, after.observation.commit?.ref);
  assert.equal(diff.events.length, 1);
  const [diffEvent] = diff.events;

  assert.ok(diffEvent !== undefined);
  assert.ok(diffEvent.event !== undefined);
  assert.ok(diffEvent.event.item !== undefined);
  assert.equal(diffEvent.event.kind, "item");
  assert.equal(diffEvent.event.item.id, "mask-shard-2");
});

test("history diff maps invalid commit refs to usage errors", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);

  const result = await runCli([
    "history",
    "diff",
    "not-a-commit",
    "also-not-a-commit",
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid commit ref/v);
});

test("history restore writes a committed Encoded Save to an explicit target", async (t) => {
  const { tempDirectory, repoPath } = await createCliHistoryRepo(t);
  const checkpointResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const checkpoint = parseStdoutJson(checkpointResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };
  const restorePath = path.join(tempDirectory, "restored-save.dat");

  const result = await runCli([
    "history",
    "restore",
    String(checkpoint.observation?.commit?.ref),
    "--to",
    restorePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /restore complete/v);
  assert.match(result.stdout, /restored-save\.dat/v);
  assert.deepEqual(
    await readFile(restorePath),
    await readFile(minimalEncodedSavePath),
  );
});

test("history restore refuses to overwrite an existing explicit target", async (t) => {
  const { tempDirectory, repoPath } = await createCliHistoryRepo(t);
  const checkpointResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const checkpoint = parseStdoutJson(checkpointResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };
  const restorePath = path.join(tempDirectory, "existing-save.dat");
  const existingBytes = new Uint8Array([9, 8, 7, 6]);

  await writeFile(restorePath, existingBytes);
  const result = await runCli([
    "history",
    "restore",
    String(checkpoint.observation?.commit?.ref),
    "--to",
    restorePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /restore target already exists/v);
  assert.deepEqual(await readFile(restorePath), Buffer.from(existingBytes));
});

test("history restore maps invalid commit refs to usage errors", async (t) => {
  const { tempDirectory, repoPath } = await createCliHistoryRepo(t);
  const restorePath = path.join(tempDirectory, "restored-save.dat");

  const result = await runCli([
    "history",
    "restore",
    "not-a-commit",
    "--to",
    restorePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid commit ref/v);
});

test("history restore writes in-place after confirmation and creates a backup", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);
  const checkpointResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const checkpoint = parseStdoutJson(checkpointResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };
  const beforeRestoreBytes = await readFile(maskShard2CollectedEncodedSavePath);

  await writeFile(watchedSavePath, beforeRestoreBytes);
  const result = await runCli([
    "history",
    "restore",
    String(checkpoint.observation?.commit?.ref),
    "--in-place",
    "--confirm-in-place",
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /restore complete/v);
  assert.match(result.stdout, /backup: .*before-restore\..*\.dat/v);
  assert.deepEqual(
    await readFile(watchedSavePath),
    await readFile(minimalEncodedSavePath),
  );

  const backupPath = parseRestoreOutputLine(result.stdout, "backup");

  assert.notEqual(backupPath, "none");
  assert.deepEqual(await readFile(backupPath), beforeRestoreBytes);
});

test("history restore refuses in-place restore without confirmation", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);
  const checkpointResult = await runCli([
    "history",
    "checkpoint",
    "--repo",
    repoPath,
    "--json",
  ]);
  const checkpoint = parseStdoutJson(checkpointResult) as {
    readonly observation?: { readonly commit?: { readonly ref?: unknown } };
  };
  const beforeRestoreBytes = await readFile(maskShard2CollectedEncodedSavePath);

  await writeFile(watchedSavePath, beforeRestoreBytes);
  const result = await runCli([
    "history",
    "restore",
    String(checkpoint.observation?.commit?.ref),
    "--in-place",
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires --confirm-in-place/v);
  assert.deepEqual(await readFile(watchedSavePath), beforeRestoreBytes);
});

test("history restore requires exactly one target mode", async (t) => {
  const { tempDirectory, repoPath } = await createCliHistoryRepo(t);
  const result = await runCli([
    "history",
    "restore",
    "HEAD",
    "--to",
    path.join(tempDirectory, "restored-save.dat"),
    "--in-place",
    "--confirm-in-place",
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /exactly one of --to or --in-place/v);
});

test("history restore rejects confirmation without in-place mode", async (t) => {
  const { repoPath } = await createCliHistoryRepo(t);
  const result = await runCli([
    "history",
    "restore",
    "HEAD",
    "--confirm-in-place",
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--confirm-in-place requires --in-place/v);
});

test("save decode prints pretty Decoded Save JSON for an Encoded Save", async () => {
  const result = await runCli(["save", "decode", minimalEncodedSavePath]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\n {2}"playerData": \{/v);
  assert.equal(result.stdout.endsWith("\n"), true);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode can print compact Decoded Save JSON", async () => {
  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--compact",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("\n  "), false);
  assert.equal(result.stdout.endsWith("\n"), true);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode writes Decoded Save JSON to an explicit output file", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const outputPath = path.join(tempDirectory, "decoded-save.json");

  await writeFile(outputPath, "old content\n");

  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--out",
    outputPath,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const decodedSave = (await readJsonFile(outputPath)) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode reports recognized schema without changing JSON output", async () => {
  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--schema-check",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /recognized save schema/v);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode reports unrecognized schema without blocking raw JSON output", async () => {
  const result = await runCli([
    "save",
    "decode",
    unrecognizedEncodedSavePath,
    "--schema-check",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: decoded save does not match a recognized schema/v,
  );
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: unknown;
  };

  assert.equal(typeof decodedSave.playerData, "object");
});

test("save decode reports decode failures without JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));

  const result = await runCli(["save", "decode", invalidSavePath]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot decode save/v);
});

test("save snapshot prints SemanticSnapshot JSON for an Encoded Save", async () => {
  const result = await runCli([
    "save",
    "snapshot",
    minimalEncodedSavePath,
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  const snapshot = parseStdoutJson(result) as {
    readonly items: readonly unknown[];
    readonly summary: { readonly completionPercentage?: unknown };
    readonly version: {
      readonly saveSchemaVersion: unknown;
      readonly semanticCoreVersion: unknown;
    };
  };

  assert.ok(snapshot.items.length > 0);
  assert.equal(snapshot.summary.completionPercentage, 39);
  assert.equal(snapshot.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(snapshot.version.semanticCoreVersion, "core-semantic-v1");
});

test("save snapshot requires JSON output mode", async () => {
  const result = await runCli(["save", "snapshot", minimalEncodedSavePath]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires --json/v);
});

test("save snapshot suggests raw decode when schema is unrecognized", async () => {
  const result = await runCli([
    "save",
    "snapshot",
    unrecognizedEncodedSavePath,
    "--json",
  ]);

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /decoded save does not match a recognized schema/v,
  );
  assert.match(result.stderr, /save decode .*unrecognized-schema-save\.dat/v);
});

test("save snapshot reports decode failures without JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));

  const result = await runCli(["save", "snapshot", invalidSavePath, "--json"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot decode save/v);
});
