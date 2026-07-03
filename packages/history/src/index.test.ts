import { strict as assert } from "node:assert";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  diffCommits,
  initSaveHistory,
  InvalidRestoreBackupDirectoryError,
  LocalHistoryApiProcessAlreadyRunningError,
  observeSave,
  queryHistory,
  rebuildSemanticReadModel,
  restoreEncodedSave,
  RestoreTargetExistsError,
  searchSemanticEvents,
  startLocalHistoryApiProcess,
} from "./index.ts";
import type {
  FileStabilityProbe,
  LocalHistoryApiProcessEvent,
  ProjectConfigOverrides,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
} from "./types.ts";

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

  await copyFile(initialSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
    config,
  });

  return {
    tempDirectory,
    repoPath,
    watchedSavePath,
  };
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

class TestWatchEventSource implements WatchEventSource {
  private onChange?: () => void | Promise<void>;

  startedWith?: WatchEventSourceStartInput;
  stopCount = 0;

  start(input: WatchEventSourceStartInput): WatchEventSubscription {
    this.startedWith = input;
    this.onChange = input.onChange;

    return {
      stop: () => {
        this.stopCount++;
      },
    };
  }

  async emitChange() {
    await this.onChange?.();
  }
}

interface TestFileStabilityProbe extends FileStabilityProbe {
  readonly checkedPaths: readonly string[];
  markStable: () => void;
}

function createTestFileStabilityProbe(): TestFileStabilityProbe {
  const checkedPaths: string[] = [];
  const stable = Promise.withResolvers<undefined>();

  return {
    checkedPaths,
    markStable() {
      stable.resolve(undefined);
    },
    async waitForStableFile(filePath: string) {
      checkedPaths.push(filePath);
      await stable.promise;
    },
  };
}

function createFailOnceFileStabilityProbe(): FileStabilityProbe {
  let shouldFail = true;

  return {
    waitForStableFile: async () => {
      await Promise.resolve();

      if (!shouldFail) {
        return;
      }

      shouldFail = false;
      throw new Error("Watched Save did not become stable.");
    },
  };
}

test("initSaveHistory creates a Save History Repository project config", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const configWithRuntimePort = {
    localApi: {
      host: "127.0.0.1",
      port: 43_117,
    },
  } as unknown as ProjectConfigOverrides;

  const result = await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
    config: configWithRuntimePort,
  });

  assert.equal(result.repoPath, repoPath);
  assert.equal(
    result.configPath,
    path.join(repoPath, ".silksong-git/config.json"),
  );
  await assert.doesNotReject(async () => await stat(repoPath));
  const configJson = await readFile(result.configPath, "utf8");
  const config = JSON.parse(configJson) as {
    watchedSavePath?: unknown;
    localApi?: { host?: unknown; port?: unknown };
  };

  assert.equal(config.watchedSavePath, minimalEncodedSavePath);
  assert.equal(config.localApi?.host, "127.0.0.1");
  assert.equal("port" in (config.localApi ?? {}), false);
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

test("startLocalHistoryApiProcess emits started and performs a startup observation", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      debounceWriteMs: 250,
      minCommitIntervalMs: 0,
    },
  });
  const watchEventSource = new TestWatchEventSource();
  const events: LocalHistoryApiProcessEvent[] = [];

  const process = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await process.stop();
  });

  assert.equal(
    watchEventSource.startedWith?.watchedSavePath,
    repo.watchedSavePath,
  );
  assert.equal(events.length, 2);
  const [startedEvent, observationEvent] = events;

  assert.ok(startedEvent !== undefined);
  assert.equal(startedEvent.type, "started");
  assert.equal(startedEvent.repoPath, repo.repoPath);
  assert.equal(startedEvent.watchedSavePath, repo.watchedSavePath);
  assert.deepEqual(startedEvent.capturePolicy, {
    debounceWriteMs: 250,
    minCommitIntervalMs: 0,
  });
  assert.ok(observationEvent !== undefined);
  assert.equal(observationEvent.type, "observation");
  assert.equal(observationEvent.cause, "startup");
  assert.equal(observationEvent.result.status, "committed");
  assert.equal(observationEvent.result.observation.trigger, "watcher");
  assert.equal(
    observationEvent.result.observation.observedAt,
    "2026-06-30T12:00:00.000Z",
  );
  await process.stop();
});

test("Local History API Process stops the watch subscription gracefully", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: LocalHistoryApiProcessEvent[] = [];

  const process = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  await process.stop();

  assert.equal(watchEventSource.stopCount, 1);
  assert.equal(events.at(-2)?.type, "stopping");
  assert.equal(events.at(-1)?.type, "stopped");
});

test("Local History API Process is a singleton per Save History Repository", async (t) => {
  const repo = await createHistoryRepo(t);
  const firstWatchEventSource = new TestWatchEventSource();
  const secondWatchEventSource = new TestWatchEventSource();
  const firstProcess = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource: firstWatchEventSource,
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await firstProcess.stop();
  });

  await assert.rejects(
    async () =>
      await startLocalHistoryApiProcess({
        repoPath: repo.repoPath,
        watchEventSource: secondWatchEventSource,
        now: () => new Date("2026-06-30T12:01:00.000Z"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof LocalHistoryApiProcessAlreadyRunningError);
      assert.equal(
        error.lockPath,
        path.join(repo.repoPath, ".silksong-git/watch.lock"),
      );
      assert.ok(error.lockInfo !== undefined);
      assert.equal(error.lockInfo.repoPath, repo.repoPath);
      assert.equal(error.lockInfo.watchedSavePath, repo.watchedSavePath);
      assert.equal(error.lockInfo.startedAt, "2026-06-30T12:00:00.000Z");
      assert.equal(secondWatchEventSource.startedWith, undefined);

      return true;
    },
  );

  await firstProcess.stop();

  const thirdProcess = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
    now: () => new Date("2026-06-30T12:02:00.000Z"),
  });

  await thirdProcess.stop();
});

test("Local History API Process observes file-change events", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: LocalHistoryApiProcessEvent[] = [];
  const process = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await watchEventSource.emitChange();

  const startupObservation = events.find(
    (
      event,
    ): event is Extract<LocalHistoryApiProcessEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "startup",
  );
  const changeObservation = events.find(
    (
      event,
    ): event is Extract<LocalHistoryApiProcessEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.ok(startupObservation !== undefined);
  if (startupObservation.result.status !== "committed") {
    assert.fail("startup observation should be committed");
  }
  assert.ok(changeObservation !== undefined);
  if (changeObservation.result.status !== "committed") {
    assert.fail("change observation should be committed");
  }
  assert.equal(changeObservation.result.observation.trigger, "watcher");
  assert.notEqual(
    changeObservation.result.observation.encodedSha256,
    startupObservation.result.observation.encodedSha256,
  );
  await process.stop();
});

test("Local History API Process waits for file stability before observing changes", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const fileStabilityProbe = createTestFileStabilityProbe();
  const events: LocalHistoryApiProcessEvent[] = [];
  const processInput = {
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe,
    onEvent: (event: LocalHistoryApiProcessEvent) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  };
  const process = await startLocalHistoryApiProcess(processInput);

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const change = watchEventSource.emitChange();
  await Promise.resolve();

  assert.deepEqual(fileStabilityProbe.checkedPaths, [repo.watchedSavePath]);
  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "change",
    ),
    false,
  );

  fileStabilityProbe.markStable();
  await change;

  const changeObservation = events.find(
    (
      event,
    ): event is Extract<LocalHistoryApiProcessEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.ok(changeObservation !== undefined);
  assert.equal(changeObservation.result.status, "committed");
  await process.stop();
});

test("Local History API Process reports stability timeout as a nonfatal Watcher Error", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: LocalHistoryApiProcessEvent[] = [];
  const process = await startLocalHistoryApiProcess({
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe: createFailOnceFileStabilityProbe(),
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await assert.doesNotReject(async () => {
    await watchEventSource.emitChange();
  });

  const failedObservation = events.find(
    (
      event,
    ): event is Extract<LocalHistoryApiProcessEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.ok(failedObservation !== undefined);
  assert.equal(failedObservation.result.status, "watcherError");
  assert.equal(failedObservation.result.error.reason, "stabilityTimeout");

  await watchEventSource.emitChange();
  const committedChange = events
    .filter(
      (
        event,
      ): event is Extract<
        LocalHistoryApiProcessEvent,
        { type: "observation" }
      > => event.type === "observation" && event.cause === "change",
    )
    .find((event) => event.result.status === "committed");

  assert.ok(committedChange !== undefined);
  await process.stop();
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
  const history = await queryHistory({
    repoPath,
    includeRawObservations: true,
  });

  assert.equal(rebuildResult.observationCount, 2);
  assert.equal(rebuildResult.recognizedObservationCount, 1);
  assert.equal(rebuildResult.unrecognizedObservationCount, 1);
  assert.equal(rebuildResult.snapshotCount, 1);
  assert.equal(rebuildResult.eventCount, 0);
  assert.equal(history.events.length, 0);
  assert.ok(history.rawObservations !== undefined);
  assert.equal(history.rawObservations.length, 2);
  const [recognizedObservation, unrecognizedObservation] =
    history.rawObservations;

  assert.ok(recognizedObservation !== undefined);
  assert.ok(unrecognizedObservation !== undefined);
  assert.equal(recognizedObservation.schema.status, "recognized");
  assert.equal(unrecognizedObservation.schema.status, "unrecognized");
  assert.equal(
    unrecognizedObservation.commit.ref,
    unrecognizedResult.observation.commit.ref,
  );
});

test("queryHistory paginates events and returns raw observations only when requested", async (t) => {
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

  const withRawObservations = await queryHistory({
    repoPath,
    includeFiltered: true,
    includeRawObservations: true,
    limit: 1,
  });

  assert.ok(withRawObservations.rawObservations !== undefined);
  assert.equal(withRawObservations.rawObservations.length, 3);
  assert.equal(
    withRawObservations.rawObservations[0]?.commit.ref,
    firstObservation.observation.commit.ref,
  );
  assert.equal(
    withRawObservations.rawObservations[2]?.commit.ref,
    thirdObservation.observation.commit.ref,
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
  assert.equal(summarySearch.events.length, 1);
  const [summaryEvent] = summarySearch.events;

  assert.ok(summaryEvent !== undefined);
  assert.equal(summaryEvent.event.kind, "summaryMetric");
  assert.equal(summaryEvent.event.direction, "progression");
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
