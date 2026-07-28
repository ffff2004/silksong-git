import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import type {
  ObserveSaveResult,
  ProjectConfigOverrides,
} from "@silksong-git/history";
import {
  initSaveHistory,
  observeSave,
  queryRawObservations,
  SaveHistoryWatcherAlreadyAcquiredError,
} from "@silksong-git/history";
import type {
  FileStabilityProbe,
  RepoSession,
  RepoSessionEvent,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
} from "./index.ts";
import { openRepoSession, RepoSessionHttpServerStartError } from "./index.ts";
import { externalWatcherFixturePath } from "./test-fixtures/external-watcher.ts";

async function startRepoSessionForTest(input: {
  readonly repoPath: string;
  readonly http?: { readonly port?: number };
  readonly watchEventSource?: WatchEventSource;
  readonly watchScheduler?: WatchScheduler;
  readonly fileStabilityProbe?: FileStabilityProbe;
  readonly onEvent?: (event: RepoSessionEvent) => void;
  readonly now?: () => Date;
}): Promise<RepoSession> {
  const session = await openRepoSession({
    repoPath: input.repoPath,
    ...(input.http?.port !== undefined && { port: input.http.port }),
    ...(input.onEvent !== undefined && { onEvent: input.onEvent }),
    runtime: {
      ...(input.watchEventSource !== undefined && {
        watchEventSource: input.watchEventSource,
      }),
      ...(input.watchScheduler !== undefined && {
        watchScheduler: input.watchScheduler,
      }),
      ...(input.fileStabilityProbe !== undefined && {
        fileStabilityProbe: input.fileStabilityProbe,
      }),
      ...(input.now !== undefined && { now: input.now }),
    },
  });
  try {
    await session.startWatching();
  } catch (error) {
    await session.stop();
    throw error;
  }

  return session;
}

const fixtureDirectory = path.join(
  import.meta.dirname,
  "../../core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const maskShard2CollectedEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-save.dat",
);
const maskShard2CollectedRosariesEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-rosaries-save.dat",
);

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function readSessionHttp(session: RepoSession) {
  return session.http;
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-history-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

interface HistoryRepoFixture {
  readonly tempDirectory: string;
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly configPath: string;
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
  const initialized = await initSaveHistory({
    repoPath,
    watchedSavePath,
    config,
  });

  return {
    tempDirectory,
    repoPath,
    watchedSavePath,
    configPath: initialized.configPath,
  };
}

async function startExternalWatcher(t: TestContext, repoPath: string) {
  const child = fork(externalWatcherFixturePath, [repoPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  let released = false;
  t.after(() => {
    if (!released) {
      child.kill();
    }
  });

  await waitForChildMessage(child, "acquired");

  return {
    async release() {
      if (released) {
        return;
      }

      child.send({ type: "release" });
      await waitForChildMessage(child, "released");
      released = true;
      child.disconnect();
    },
  };
}

async function waitForChildMessage(
  child: ReturnType<typeof fork>,
  expectedType: string,
) {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object"
        || message === null
        || !("type" in message)
      ) {
        return;
      }
      if (message.type === "error") {
        cleanUp();
        reject(
          new Error(
            "message" in message ? String(message.message) : "Child failed.",
          ),
        );
      } else if (message.type === expectedType) {
        cleanUp();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanUp();
      reject(
        new Error(`Child exited before ${expectedType} with code ${code}.`),
      );
    };
    const cleanUp = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };

    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

class TestWatchEventSource implements WatchEventSource {
  private onChange?: () => void | Promise<void>;
  private onError?: (error: unknown) => void | Promise<void>;

  startedWith?: WatchEventSourceStartInput;
  stopCount = 0;

  start(input: WatchEventSourceStartInput): WatchEventSubscription {
    this.startedWith = input;
    this.onChange = input.onChange;
    this.onError = input.onError;

    return {
      stop: () => {
        this.stopCount++;
      },
    };
  }

  async emitChange() {
    await this.onChange?.();
  }

  async emitError(error: unknown) {
    await this.onError?.(error);
  }
}

class TestWatchScheduler implements WatchScheduler {
  readonly scheduled: Array<{
    readonly runAt: Date;
    readonly run: () => Promise<void>;
    canceled: boolean;
  }> = [];

  scheduleAt(runAt: Date, task: () => void | Promise<void>) {
    const scheduledTask = {
      runAt,
      canceled: false,
      run: async () => {
        if (!scheduledTask.canceled) {
          await task();
        }
      },
    };

    this.scheduled.push(scheduledTask);

    return {
      cancel: () => {
        scheduledTask.canceled = true;
      },
    };
  }
}

interface BlockingStabilityProbe extends FileStabilityProbe {
  readonly checkCount: number;
  readonly activeCheckCount: number;
  readonly maximumActiveCheckCount: number;
  blockNextCheck: () => {
    readonly waitForCheck: () => Promise<void>;
    readonly release: () => void;
  };
}

function createBlockingStabilityProbe(): BlockingStabilityProbe {
  let checkCount = 0;
  let activeCheckCount = 0;
  let maximumActiveCheckCount = 0;
  let nextGate:
    | {
        readonly checkStarted: PromiseWithResolvers<undefined>;
        readonly stable: PromiseWithResolvers<undefined>;
      }
    | undefined;

  return {
    get checkCount() {
      return checkCount;
    },
    get activeCheckCount() {
      return activeCheckCount;
    },
    get maximumActiveCheckCount() {
      return maximumActiveCheckCount;
    },
    blockNextCheck() {
      const gate = {
        checkStarted: Promise.withResolvers<undefined>(),
        stable: Promise.withResolvers<undefined>(),
      };

      nextGate = gate;

      return {
        waitForCheck: async () => {
          await gate.checkStarted.promise;
        },
        release: () => {
          gate.stable.resolve(undefined);
        },
      };
    },
    async waitForStableFile() {
      checkCount++;
      activeCheckCount++;
      maximumActiveCheckCount = Math.max(
        maximumActiveCheckCount,
        activeCheckCount,
      );
      const gate = nextGate;
      nextGate = undefined;
      const stable =
        gate === undefined ? Promise.resolve(undefined) : gate.stable.promise;

      if (gate !== undefined) {
        gate.checkStarted.resolve(undefined);
      }

      try {
        await stable;
      } finally {
        activeCheckCount--;
      }
    },
  };
}

function createFailOnceFileStabilityProbe(failOnCheck = 1): FileStabilityProbe {
  let checkCount = 0;

  return {
    waitForStableFile: async () => {
      checkCount++;

      if (checkCount !== failOnCheck) {
        return;
      }

      throw new Error("Watched Save did not become stable.");
    },
  };
}

interface SequencedFileStabilityProbe extends FileStabilityProbe {
  readonly checkedPaths: readonly string[];
  markStable: () => void;
  waitForCheckCount: (count: number) => Promise<void>;
}

function createSequencedFileStabilityProbe(): SequencedFileStabilityProbe {
  const checkedPaths: string[] = [];
  const stableResolvers: Array<(value: undefined) => void> = [];
  const checkWaiters: Array<{
    readonly count: number;
    readonly resolve: (value: undefined) => void;
  }> = [];

  function notifyCheckWaiters() {
    for (const waiter of checkWaiters) {
      if (checkedPaths.length >= waiter.count) {
        waiter.resolve(undefined);
      }
    }
  }

  return {
    checkedPaths,
    markStable() {
      const resolve = stableResolvers.shift();

      if (resolve === undefined) {
        throw new Error("no pending stability probe");
      }

      resolve(undefined);
    },
    async waitForCheckCount(count: number) {
      if (checkedPaths.length >= count) {
        return;
      }

      const waiter = Promise.withResolvers<undefined>();

      checkWaiters.push({
        count,
        resolve: waiter.resolve,
      });

      await waiter.promise;
    },
    async waitForStableFile(filePath: string) {
      checkedPaths.push(filePath);
      notifyCheckWaiters();
      const stable = Promise.withResolvers<undefined>();

      stableResolvers.push(stable.resolve);

      await stable.promise;
    },
  };
}

async function startWatchProcessWithSequencedStartupStability(
  input: Parameters<typeof startRepoSessionForTest>[0],
  fileStabilityProbe: SequencedFileStabilityProbe,
): Promise<{
  readonly process: Awaited<ReturnType<typeof startRepoSessionForTest>>;
  readonly startupStabilityCheckCount: number;
}> {
  const start = startRepoSessionForTest(input);
  const first = await Promise.race([
    fileStabilityProbe
      .waitForCheckCount(1)
      .then(() => ({ type: "stabilityCheck" as const })),
    start.then((process) => ({ type: "process" as const, process })),
  ]);

  if (first.type === "process") {
    return { process: first.process, startupStabilityCheckCount: 0 };
  }

  fileStabilityProbe.markStable();

  return {
    process: await start,
    startupStabilityCheckCount: 1,
  };
}

test("startRepoSessionForTest emits started and performs a startup observation", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      debounceWriteMs: 250,
      minCommitIntervalMs: 0,
    },
  });
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];

  const process = await startRepoSessionForTest({
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

test("startRepoSessionForTest waits for file stability before its startup observation", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const fileStabilityProbe = createSequencedFileStabilityProbe();
  const events: RepoSessionEvent[] = [];
  const start = startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  const first = await Promise.race([
    fileStabilityProbe
      .waitForCheckCount(1)
      .then(() => ({ type: "stabilityCheck" as const })),
    start.then((process) => ({ type: "process" as const, process })),
  ]);

  if (first.type === "process") {
    await first.process.stop();
    assert.fail("startup observation must begin with a stability check");
  }

  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "startup",
    ),
    false,
  );

  fileStabilityProbe.markStable();
  const process = await start;

  t.after(async () => {
    await process.stop();
  });

  assert.deepEqual(fileStabilityProbe.checkedPaths, [repo.watchedSavePath]);
  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "startup",
    ),
    true,
  );
  await process.stop();
});

test("Repo Session keeps mandatory authenticated HTTP stable across watcher lifecycle", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    http: {},
    watchEventSource,
    onEvent: (event) => {
      events.push(event);
    },
  });

  t.after(async () => {
    await process.stop();
  });

  assert.match(process.http.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/v);
  assert.match(process.http.token, /^[\w\-]{43}$/v);
  const started = events.find((event) => event.type === "started");

  assert.equal(started?.type, "started");
  assert.equal("http" in started, false);

  const response = await fetch(`${process.http.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${process.http.token}` },
  });

  assert.equal(response.status, 200);
  const watcherBody = await readJson<{
    observationRevision: number;
    activity: string;
    lastObservation?: { status?: string };
  }>(response);

  assert.equal(watcherBody.observationRevision, 1);
  assert.equal(watcherBody.activity, "idle");
  assert.equal(watcherBody.lastObservation?.status, "committed");
  assert.equal("events" in watcherBody, false);

  const http = readSessionHttp(process);
  await process.stopWatching();
  assert.deepEqual(readSessionHttp(process), http);
  assert.equal(process.getWatcherStatus().status, "inactive");
  await process.startWatching();
  assert.deepEqual(readSessionHttp(process), http);

  await process.stop();
  await assert.rejects(fetch(`${http.endpoint}/api/v1/watcher`));
});

test("HTTP startup uses fixed loopback binding and rejects occupied ports", async (t) => {
  const repo = await createHistoryRepo(t);
  const configPath = path.join(repo.repoPath, ".silksong-git/config.json");
  const validConfig = await readFile(configPath, "utf8");

  const legacyConfig = JSON.parse(validConfig) as Record<string, unknown>;
  legacyConfig["localApi"] = { host: "0.0.0.0" };
  await writeFile(configPath, `${JSON.stringify(legacyConfig)}\n`);
  const legacyConfigProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    http: {},
    watchEventSource: new TestWatchEventSource(),
  });
  assert.match(
    legacyConfigProcess.http.endpoint,
    /^http:\/\/127\.0\.0\.1:\d+$/v,
  );
  await legacyConfigProcess.stop();

  const occupiedServer = createServer();

  await new Promise<void>((resolve) => {
    occupiedServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => {
      occupiedServer.close(() => {
        resolve();
      });
    });
  });
  const address = occupiedServer.address();

  assert.ok(address !== null && typeof address !== "string");
  await assert.rejects(
    startRepoSessionForTest({
      repoPath: repo.repoPath,
      http: { port: address.port },
      watchEventSource: new TestWatchEventSource(),
    }),
    RepoSessionHttpServerStartError,
  );

  const nextProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
  });

  await nextProcess.stop();
});

test("Repo Session stops the watch subscription gracefully", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];

  const process = await startRepoSessionForTest({
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

test("Repo Session is a singleton per Save History Repository", async (t) => {
  const repo = await createHistoryRepo(t);
  const firstWatchEventSource = new TestWatchEventSource();
  const secondWatchEventSource = new TestWatchEventSource();
  const firstProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: firstWatchEventSource,
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await firstProcess.stop();
  });

  await assert.rejects(
    async () =>
      await startRepoSessionForTest({
        repoPath: repo.repoPath,
        watchEventSource: secondWatchEventSource,
        now: () => new Date("2026-06-30T12:01:00.000Z"),
      }),
    (error: unknown) => {
      assert.ok(error instanceof SaveHistoryWatcherAlreadyAcquiredError);
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

  const thirdProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
    now: () => new Date("2026-06-30T12:02:00.000Z"),
  });

  await thirdProcess.stop();
});

test("Repo Session releases watcher ownership after watch startup failure", async (t) => {
  const repo = await createHistoryRepo(t);
  const startFailure = new Error("watch subscription could not start");
  const failingWatchEventSource: WatchEventSource = {
    start: async () => {
      throw startFailure;
    },
  };

  const reader = await openRepoSession({
    repoPath: repo.repoPath,
    runtime: { watchEventSource: failingWatchEventSource },
  });
  t.after(async () => {
    await reader.stop();
  });

  await assert.rejects(reader.startWatching(), startFailure);
  assert.equal(reader.getWatcherStatus().status, "inactive");
  const response = await fetch(`${reader.http.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${reader.http.token}` },
  });
  assert.equal(response.status, 200);

  const nextProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
  });

  await nextProcess.stop();
});

test("watch backend error reported before subscription return fails startup cleanly", async (t) => {
  const repo = await createHistoryRepo(t);
  const startFailure = new Error("watch backend failed during startup");
  let startCount = 0;
  let stopCount = 0;
  const session = await openRepoSession({
    repoPath: repo.repoPath,
    runtime: {
      fileStabilityProbe: { waitForStableFile: async () => undefined },
      watchEventSource: {
        async start(input) {
          startCount++;
          if (startCount === 1) {
            await input.onError(startFailure);
          }

          return {
            stop() {
              stopCount++;
            },
          };
        },
      },
    },
  });
  t.after(async () => {
    await session.stop();
  });

  await assert.rejects(session.startWatching(), (error: unknown) => {
    assert.equal(error, startFailure);

    return true;
  });
  assert.equal(session.getWatcherStatus().status, "inactive");
  assert.equal(stopCount, 1);
  const response = await fetch(`${session.http.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${session.http.token}` },
  });
  assert.equal(response.status, 200);
  const watcherStatus = await readJson<{ status: string }>(response);
  assert.equal(watcherStatus.status, "inactive");

  await session.startWatching();
  assert.equal(session.getWatcherStatus().status, "running");
  assert.equal(startCount, 2);
});

test("Repo Session observes file-change events", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0 },
  });
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
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
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "startup",
  );
  const changeObservation = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
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

test("Repo Session waits for file stability before observing changes", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0 },
  });
  const watchEventSource = new TestWatchEventSource();
  const fileStabilityProbe = createSequencedFileStabilityProbe();
  const events: RepoSessionEvent[] = [];
  const processInput = {
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe,
    onEvent: (event: RepoSessionEvent) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  };
  const { process, startupStabilityCheckCount } =
    await startWatchProcessWithSequencedStartupStability(
      processInput,
      fileStabilityProbe,
    );

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const change = watchEventSource.emitChange();
  await fileStabilityProbe.waitForCheckCount(startupStabilityCheckCount + 1);

  assert.deepEqual(
    fileStabilityProbe.checkedPaths,
    Array.from(
      { length: startupStabilityCheckCount + 1 },
      () => repo.watchedSavePath,
    ),
  );
  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "change",
    ),
    false,
  );

  fileStabilityProbe.markStable();
  await change;

  const changeObservation = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.ok(changeObservation !== undefined);
  assert.equal(changeObservation.result.status, "committed");
  await process.stop();
});

test("Repo Session reports stability timeout as a nonfatal Watcher Error", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0 },
  });
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe: createFailOnceFileStabilityProbe(2),
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
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.ok(failedObservation !== undefined);
  assert.equal(failedObservation.result.status, "watcherError");
  assert.equal(failedObservation.result.error.reason, "stabilityTimeout");

  await watchEventSource.emitChange();
  const committedChange = events
    .filter(
      (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
        event.type === "observation" && event.cause === "change",
    )
    .find((event) => event.result.status === "committed");

  assert.ok(committedChange !== undefined);
  await process.stop();
});

test("Repo Session coalesces change events while an observation is running", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0 },
  });
  const watchEventSource = new TestWatchEventSource();
  const fileStabilityProbe = createSequencedFileStabilityProbe();
  const events: RepoSessionEvent[] = [];
  const { process, startupStabilityCheckCount } =
    await startWatchProcessWithSequencedStartupStability(
      {
        repoPath: repo.repoPath,
        watchEventSource,
        fileStabilityProbe,
        onEvent: (event) => {
          events.push(event);
        },
        now: () => new Date("2026-06-30T12:00:00.000Z"),
      },
      fileStabilityProbe,
    );

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const firstChange = watchEventSource.emitChange();
  await fileStabilityProbe.waitForCheckCount(startupStabilityCheckCount + 1);

  await copyFile(
    maskShard2CollectedRosariesEncodedSavePath,
    repo.watchedSavePath,
  );
  const secondChange = watchEventSource.emitChange();

  assert.deepEqual(
    fileStabilityProbe.checkedPaths,
    Array.from(
      { length: startupStabilityCheckCount + 1 },
      () => repo.watchedSavePath,
    ),
  );

  fileStabilityProbe.markStable();
  await fileStabilityProbe.waitForCheckCount(startupStabilityCheckCount + 2);
  fileStabilityProbe.markStable();
  await Promise.all([firstChange, secondChange]);

  const changeObservations = events.filter(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "change",
  );

  assert.equal(changeObservations.length, 2);
  assert.equal(changeObservations[0]?.result.status, "committed");
  assert.equal(changeObservations[1]?.result.status, "skipped");
  await process.stop();
});

test("Repo Session schedules a deferred observation after a minimum-interval skip", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      debounceWriteMs: 0,
      minCommitIntervalMs: 60 * 1000,
    },
  });
  const watchEventSource = new TestWatchEventSource();
  const watchScheduler = new TestWatchScheduler();
  const fileStabilityProbe = createSequencedFileStabilityProbe();
  const events: RepoSessionEvent[] = [];
  let now = new Date("2026-06-30T12:00:00.000Z");
  const { process, startupStabilityCheckCount } =
    await startWatchProcessWithSequencedStartupStability(
      {
        repoPath: repo.repoPath,
        watchEventSource,
        watchScheduler,
        fileStabilityProbe,
        onEvent: (event) => {
          events.push(event);
        },
        now: () => now,
      },
      fileStabilityProbe,
    );

  t.after(async () => {
    await process.stop();
  });

  now = new Date("2026-06-30T12:00:10.000Z");
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const change = watchEventSource.emitChange();
  await fileStabilityProbe.waitForCheckCount(startupStabilityCheckCount + 1);
  fileStabilityProbe.markStable();
  await change;

  assert.equal(watchScheduler.scheduled.length, 1);
  const [scheduledDeferred] = watchScheduler.scheduled;

  assert.ok(scheduledDeferred !== undefined);
  assert.equal(
    scheduledDeferred.runAt.toISOString(),
    "2026-06-30T12:01:00.000Z",
  );

  await copyFile(
    maskShard2CollectedRosariesEncodedSavePath,
    repo.watchedSavePath,
  );
  now = new Date("2026-06-30T12:01:00.000Z");
  const deferred = scheduledDeferred.run();

  await fileStabilityProbe.waitForCheckCount(startupStabilityCheckCount + 2);
  fileStabilityProbe.markStable();
  await deferred;

  const deferredObservation = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "deferred",
  );

  assert.ok(deferredObservation !== undefined);
  assert.equal(deferredObservation.result.status, "committed");
  assert.equal(
    deferredObservation.result.observation.observedAt,
    "2026-06-30T12:01:00.000Z",
  );
  assert.deepEqual(
    fileStabilityProbe.checkedPaths,
    Array.from(
      { length: startupStabilityCheckCount + 2 },
      () => repo.watchedSavePath,
    ),
  );
  await process.stop();
});

test("Repo Session applies debounce before probing a real file change", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 500 },
  });
  const watchEventSource = new TestWatchEventSource();
  const watchScheduler = new TestWatchScheduler();
  const events: RepoSessionEvent[] = [];
  let stabilityCheckCount = 0;
  let now = new Date("2026-06-30T12:00:00.000Z");
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    watchScheduler,
    fileStabilityProbe: {
      waitForStableFile: async () => {
        stabilityCheckCount++;
      },
    },
    onEvent: (event) => {
      events.push(event);
    },
    now: () => now,
  });

  t.after(async () => {
    await process.stop();
  });

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await watchEventSource.emitChange();

  assert.equal(stabilityCheckCount, 1);
  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "change",
    ),
    false,
  );
  assert.equal(watchScheduler.scheduled.length, 1);
  const [debouncedChange] = watchScheduler.scheduled;

  assert.ok(debouncedChange !== undefined);
  assert.equal(debouncedChange.runAt.toISOString(), "2026-06-30T12:00:00.500Z");

  now = new Date("2026-06-30T12:00:00.500Z");
  await debouncedChange.run();

  assert.equal(stabilityCheckCount, 2);
  assert.equal(
    events.filter(
      (event) => event.type === "observation" && event.cause === "change",
    ).length,
    1,
  );
  await process.stop();
});

test("Repo Session merges later changes into one deferred observation", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: {
      debounceWriteMs: 500,
      minCommitIntervalMs: 60 * 1000,
    },
  });
  const watchEventSource = new TestWatchEventSource();
  const watchScheduler = new TestWatchScheduler();
  const events: RepoSessionEvent[] = [];
  const fileStabilityProbe = createBlockingStabilityProbe();
  let now = new Date("2026-06-30T12:00:00.000Z");
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    watchScheduler,
    fileStabilityProbe,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => now,
  });

  t.after(async () => {
    await process.stop();
  });

  now = new Date("2026-06-30T12:00:10.000Z");
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await watchEventSource.emitChange();

  const [firstDebouncedChange] = watchScheduler.scheduled;

  assert.ok(firstDebouncedChange !== undefined);
  assert.equal(
    firstDebouncedChange.runAt.toISOString(),
    "2026-06-30T12:00:10.500Z",
  );

  now = new Date("2026-06-30T12:00:10.500Z");
  await firstDebouncedChange.run();

  assert.equal(
    events.filter(
      (event) => event.type === "observation" && event.cause === "change",
    ).length,
    1,
  );

  now = new Date("2026-06-30T12:00:20.000Z");
  await copyFile(
    maskShard2CollectedRosariesEncodedSavePath,
    repo.watchedSavePath,
  );
  await watchEventSource.emitChange();

  assert.equal(fileStabilityProbe.checkCount, 2);
  assert.equal(fileStabilityProbe.activeCheckCount, 0);

  assert.equal(
    events.filter(
      (event) => event.type === "observation" && event.cause === "change",
    ).length,
    1,
  );

  const pendingDeferred = watchScheduler.scheduled.filter(
    (scheduled) =>
      !scheduled.canceled
      && scheduled.runAt.toISOString() === "2026-06-30T12:01:00.000Z",
  );

  assert.equal(pendingDeferred.length, 1);
  const [deferredTask] = pendingDeferred;

  assert.ok(deferredTask !== undefined);
  now = new Date("2026-06-30T12:01:00.000Z");
  const deferredProbe = fileStabilityProbe.blockNextCheck();
  const deferred = deferredTask.run();

  await deferredProbe.waitForCheck();
  assert.equal(fileStabilityProbe.activeCheckCount, 1);
  assert.equal(fileStabilityProbe.maximumActiveCheckCount, 1);
  deferredProbe.release();
  await deferred;

  const deferredObservation = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation" && event.cause === "deferred",
  );

  assert.ok(deferredObservation !== undefined);
  assert.equal(deferredObservation.result.status, "committed");
  const expectedHash = createHash("sha256")
    .update(await readFile(maskShard2CollectedRosariesEncodedSavePath))
    .digest("hex");

  assert.equal(
    deferredObservation.result.observation.encodedSha256,
    expectedHash,
  );
  await process.stop();
});

test("Repo Session cancels a deferred observation that has not started", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0, minCommitIntervalMs: 60 * 1000 },
  });
  const watchEventSource = new TestWatchEventSource();
  const watchScheduler = new TestWatchScheduler();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    watchScheduler,
    fileStabilityProbe: { waitForStableFile: async () => undefined },
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

  const [deferredTask] = watchScheduler.scheduled;

  assert.ok(deferredTask !== undefined);
  await process.stop();

  assert.equal(deferredTask.canceled, true);
  await deferredTask.run();
  assert.equal(
    events.some(
      (event) => event.type === "observation" && event.cause === "deferred",
    ),
    false,
  );
});

test("Repo Session waits for an active deferred observation before releasing watch ownership", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0, minCommitIntervalMs: 60 * 1000 },
  });
  const watchEventSource = new TestWatchEventSource();
  const watchScheduler = new TestWatchScheduler();
  const fileStabilityProbe = createBlockingStabilityProbe();
  let now = new Date("2026-06-30T12:00:00.000Z");
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    watchScheduler,
    fileStabilityProbe,
    now: () => now,
  });

  t.after(async () => {
    await process.stop();
  });

  const changeProbe = fileStabilityProbe.blockNextCheck();
  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const change = watchEventSource.emitChange();
  await changeProbe.waitForCheck();
  changeProbe.release();
  await change;

  const [deferredTask] = watchScheduler.scheduled;

  assert.ok(deferredTask !== undefined);
  const deferredProbe = fileStabilityProbe.blockNextCheck();
  now = new Date("2026-06-30T12:01:00.000Z");
  const deferred = deferredTask.run();
  await deferredProbe.waitForCheck();

  const { endpoint } = process.http;
  const { token } = process.http;
  let stopCompleted = false;
  const stop = process.stop();
  stop
    .then(() => {
      stopCompleted = true;
    })
    .catch(() => undefined);
  while (process.getWatcherStatus().status !== "stopping") {
    await Promise.resolve();
  }
  assert.equal(stopCompleted, false);
  const rejectedRequest = await fetch(`${endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(
    (response) => ({ type: "response" as const, response }),
    (error: unknown) => ({ type: "networkError" as const, error }),
  );
  if (rejectedRequest.type === "response") {
    assert.equal(rejectedRequest.response.status, 503);
  }
  const competingStart = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
    fileStabilityProbe: { waitForStableFile: async () => undefined },
  }).then(
    (nextProcess) => ({ type: "started" as const, nextProcess }),
    (error: unknown) => ({ type: "rejected" as const, error }),
  );

  deferredProbe.release();
  await Promise.all([deferred, stop]);
  assert.equal(stopCompleted, true);

  if (competingStart.type === "started") {
    await competingStart.nextProcess.stop();
    assert.fail(
      "watch ownership must remain held while deferred work is active",
    );
  }

  assert.ok(
    competingStart.error instanceof SaveHistoryWatcherAlreadyAcquiredError,
  );

  const nextProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
    fileStabilityProbe: { waitForStableFile: async () => undefined },
  });

  await nextProcess.stop();
});

test("Repo Session reports save read failures as nonfatal Watcher Errors", async (t) => {
  const repo = await createHistoryRepo(t, minimalEncodedSavePath, {
    capturePolicy: { debounceWriteMs: 0 },
  });
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource,
    fileStabilityProbe: {
      waitForStableFile: async () => undefined,
    },
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date("2026-06-30T12:00:00.000Z"),
  });

  t.after(async () => {
    await process.stop();
  });

  await rm(repo.watchedSavePath);
  await assert.doesNotReject(async () => {
    await watchEventSource.emitChange();
  });

  const failedObservation = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation"
      && event.cause === "change"
      && event.result.status === "watcherError",
  );

  assert.ok(failedObservation !== undefined);
  assert.equal(failedObservation.result.status, "watcherError");
  assert.equal(failedObservation.result.error.reason, "readFailure");

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await watchEventSource.emitChange();

  const committedChange = events.find(
    (event): event is Extract<RepoSessionEvent, { type: "observation" }> =>
      event.type === "observation"
      && event.cause === "change"
      && event.result.status === "committed",
  );

  assert.ok(committedChange !== undefined);
  await process.stop();
});

test("Repo Session stops only watching after a fatal watch backend failure", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const events: RepoSessionEvent[] = [];
  const process = await startRepoSessionForTest({
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

  await watchEventSource.emitError(new Error("watch backend failed"));

  const fatalEvent = events.find((event) => event.type === "fatalError");

  assert.ok(fatalEvent !== undefined);
  assert.equal(fatalEvent.error.reason, "watchBackendFailure");
  assert.equal(fatalEvent.error.message, "watch backend failed");
  assert.equal(process.getWatcherStatus().status, "inactive");
  const response = await fetch(`${process.http.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${process.http.token}` },
  });
  assert.equal(response.status, 200);

  const nextProcess = await startRepoSessionForTest({
    repoPath: repo.repoPath,
    watchEventSource: new TestWatchEventSource(),
    now: () => new Date("2026-06-30T12:01:00.000Z"),
  });

  await nextProcess.stop();
});

test("openRepoSession returns an inactive reader without acquiring watcher ownership", async (t) => {
  const repo = await createHistoryRepo(t);
  const first = await openRepoSession({ repoPath: repo.repoPath });
  const second = await openRepoSession({ repoPath: repo.repoPath });
  t.after(async () => {
    await Promise.all([first.stop(), second.stop()]);
  });

  assert.equal(first.getWatcherStatus().status, "inactive");
  assert.equal(second.getWatcherStatus().status, "inactive");
  assert.notEqual(first.http.endpoint, second.http.endpoint);
  assert.notEqual(first.http.token, second.http.token);

  await first.startWatching();
  await assert.rejects(
    second.startWatching(),
    SaveHistoryWatcherAlreadyAcquiredError,
  );
  assert.equal(second.getWatcherStatus().status, "inactive");
  await first.stopWatching();
  await second.startWatching();
  assert.equal(second.getWatcherStatus().status, "running");
});

test("concurrent watcher lifecycle calls linearize and same-state calls are idempotent", async (t) => {
  const repo = await createHistoryRepo(t);
  const watchEventSource = new TestWatchEventSource();
  const session = await openRepoSession({
    repoPath: repo.repoPath,
    runtime: {
      fileStabilityProbe: { waitForStableFile: async () => undefined },
      watchEventSource,
    },
  });
  t.after(async () => {
    await session.stop();
  });

  await Promise.all([session.startWatching(), session.startWatching()]);
  assert.equal(session.getWatcherStatus().status, "running");
  await Promise.all([session.stopWatching(), session.stopWatching()]);
  assert.equal(session.getWatcherStatus().status, "inactive");
  assert.equal(watchEventSource.stopCount, 1);

  const start = session.startWatching();
  const stop = session.stopWatching();
  await Promise.all([start, stop]);
  assert.equal(session.getWatcherStatus().status, "inactive");
  assert.equal(watchEventSource.stopCount, 2);
});

test("watcher transitional statuses expose only lifecycle-valid fields", async (t) => {
  const repo = await createHistoryRepo(t);
  const startEntered = Promise.withResolvers<undefined>();
  const allowStart = Promise.withResolvers<undefined>();
  const stopEntered = Promise.withResolvers<undefined>();
  const allowStop = Promise.withResolvers<undefined>();
  const session = await openRepoSession({
    repoPath: repo.repoPath,
    runtime: {
      fileStabilityProbe: { waitForStableFile: async () => undefined },
      watchEventSource: {
        async start() {
          startEntered.resolve(undefined);
          await allowStart.promise;

          return {
            async stop() {
              stopEntered.resolve(undefined);
              await allowStop.promise;
            },
          };
        },
      },
    },
  });
  t.after(async () => {
    allowStart.resolve(undefined);
    allowStop.resolve(undefined);
    await session.stop();
  });

  const start = session.startWatching();
  await startEntered.promise;
  const starting = session.getWatcherStatus();
  assert.equal(starting.status, "starting");
  assert.equal("watchedSavePath" in starting, false);
  assert.equal("activity" in starting, false);
  allowStart.resolve(undefined);
  await start;

  const stop = session.stopWatching();
  await stopEntered.promise;
  const stopping = session.getWatcherStatus();
  assert.equal(stopping.status, "stopping");
  assert.equal("watchedSavePath" in stopping, true);
  assert.equal("activity" in stopping, true);
  allowStop.resolve(undefined);
  await stop;
  assert.equal(session.getWatcherStatus().status, "inactive");
});

test("stop immediately closes HTTP admission while startup observation drains", async (t) => {
  const repo = await createHistoryRepo(t);
  const fileStabilityProbe = createBlockingStabilityProbe();
  const startupProbe = fileStabilityProbe.blockNextCheck();
  const events: RepoSessionEvent[] = [];
  const session = await openRepoSession({
    repoPath: repo.repoPath,
    onEvent: (event) => {
      events.push(event);
    },
    runtime: {
      fileStabilityProbe,
      watchEventSource: new TestWatchEventSource(),
    },
  });
  t.after(async () => {
    startupProbe.release();
    await session.stop();
  });
  const start = session.startWatching();
  await startupProbe.waitForCheck();

  let startCompleted = false;
  let stopCompleted = false;
  start
    .then(() => {
      startCompleted = true;
    })
    .catch(() => undefined);
  const stop = session.stop();
  const repeatedStop = session.stop();
  stop
    .then(() => {
      stopCompleted = true;
    })
    .catch(() => undefined);

  assert.equal(events.filter((event) => event.type === "stopping").length, 1);
  const rejected = await fetch(`${session.http.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${session.http.token}` },
  });
  assert.equal(rejected.status, 503);
  assert.deepEqual(await readJson(rejected), {
    error: {
      code: "session_stopping",
      message: "Repo Session is stopping.",
    },
  });
  assert.equal(startCompleted, false);
  assert.equal(stopCompleted, false);

  startupProbe.release();
  await Promise.all([start, stop, repeatedStop]);
  assert.equal(startCompleted, true);
  assert.equal(stopCompleted, true);
  assert.equal(session.getWatcherStatus().status, "inactive");

  const nextSession = await openRepoSession({
    repoPath: repo.repoPath,
    runtime: {
      fileStabilityProbe: { waitForStableFile: async () => undefined },
      watchEventSource: new TestWatchEventSource(),
    },
  });
  await nextSession.startWatching();
  await nextSession.stop();
});

test("reader HTTP queries and mutations work beside a real external watcher process", async (t) => {
  const repo = await createHistoryRepo(t);
  const baseline = await observeSave({
    repoPath: repo.repoPath,
    trigger: "manualCheckpoint",
  });
  if (baseline.status !== "committed") {
    assert.fail("baseline observation should be committed");
  }

  const externalWatcher = await startExternalWatcher(t, repo.repoPath);
  const reader = await openRepoSession({ repoPath: repo.repoPath });
  t.after(async () => {
    await reader.stop();
  });
  const headers = { Authorization: `Bearer ${reader.http.token}` };

  await assert.rejects(
    reader.startWatching(),
    SaveHistoryWatcherAlreadyAcquiredError,
  );
  assert.equal(reader.getWatcherStatus().status, "inactive");
  const watcherResponse = await fetch(
    `${reader.http.endpoint}/api/v1/watcher`,
    { headers },
  );
  assert.equal(watcherResponse.status, 200);
  const watcherStatus = await readJson<{ status: string }>(watcherResponse);
  assert.equal(watcherStatus.status, "inactive");

  await rm(repo.watchedSavePath);
  const saveResponse = await fetch(
    `${reader.http.endpoint}/api/v1/save?selector=latest`,
    { headers },
  );
  assert.equal(saveResponse.status, 200);
  const exportResponse = await fetch(
    `${reader.http.endpoint}/api/v1/export?commit=${baseline.observation.commit.ref}`,
    { headers },
  );
  assert.equal(exportResponse.status, 200);
  assert.deepEqual(
    Buffer.from(await exportResponse.arrayBuffer()),
    await readFile(minimalEncodedSavePath),
  );

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  const checkpointResponse = await fetch(
    `${reader.http.endpoint}/api/v1/checkpoints`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(checkpointResponse.status, 200);
  const checkpoint = await readJson<ObserveSaveResult>(checkpointResponse);
  if (checkpoint.status !== "committed") {
    assert.fail("Manual Checkpoint should be committed");
  }

  const restoreResponse = await fetch(
    `${reader.http.endpoint}/api/v1/restores/in-place`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        commitRef: baseline.observation.commit.ref,
        confirmation: "restore-watched-save",
        expectedCurrent: {
          status: "present",
          encodedSha256: checkpoint.observation.encodedSha256,
        },
      }),
    },
  );
  assert.equal(restoreResponse.status, 200);
  assert.deepEqual(
    await readFile(repo.watchedSavePath),
    await readFile(minimalEncodedSavePath),
  );

  await externalWatcher.release();
  await reader.startWatching();
  assert.equal(reader.getWatcherStatus().status, "running");
});

test("session shutdown rejects new HTTP while draining an admitted History handler", async (t) => {
  const repo = await createHistoryRepo(t);
  const session = await openRepoSession({ repoPath: repo.repoPath });
  const endpoint = new URL(session.http.endpoint);
  const socket = createConnection({
    host: endpoint.hostname,
    port: Number(endpoint.port),
  });
  t.after(() => {
    socket.destroy();
  });
  await once(socket, "connect");
  let responseText = "";
  socket.on("data", (chunk: Buffer) => {
    responseText += chunk.toString("utf8");
  });
  socket.write(
    [
      "POST /api/v1/checkpoints HTTP/1.1",
      `Host: ${endpoint.host}`,
      `Authorization: Bearer ${session.http.token}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "Expect: 100-continue",
      "",
      "",
    ].join("\r\n"),
  );

  while (!responseText.includes("100 Continue")) {
    await once(socket, "data");
  }

  let stopCompleted = false;
  const stop = session.stop().then(() => {
    stopCompleted = true;
  });
  const rejectedRequest = await fetch(
    `${session.http.endpoint}/api/v1/watcher`,
    {
      headers: { Authorization: `Bearer ${session.http.token}` },
    },
  ).then(
    (response) => ({ type: "response" as const, response }),
    () => ({ type: "networkError" as const }),
  );
  if (rejectedRequest.type === "response") {
    assert.equal(rejectedRequest.response.status, 503);
  }
  assert.equal(stopCompleted, false);

  socket.end("{}");
  await once(socket, "close");
  await stop;

  const observations = await queryRawObservations({ repoPath: repo.repoPath });
  assert.equal(observations.entries.length, 1);
});
