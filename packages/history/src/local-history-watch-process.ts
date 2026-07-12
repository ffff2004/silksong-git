import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { readProjectConfig } from "./config.ts";
import { LocalHttpServerStartError } from "./errors.ts";
import { createLocalHttpApp } from "./http-app.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import type {
  FileStabilityProbe,
  LocalHistoryWatchProcess,
  ObserveSaveResult,
  ScheduledWatchTask,
  StartLocalHistoryWatchProcessInput,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
} from "./types.ts";
import { acquireWatchLock } from "./watch-lock.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export async function startLocalHistoryWatchProcess(
  input: StartLocalHistoryWatchProcessInput,
): Promise<LocalHistoryWatchProcess> {
  const config = await readProjectConfig(input.repoPath);
  const emit = input.onEvent ?? (() => undefined);
  const now = input.now?.() ?? new Date();
  const fileStabilityProbe =
    input.fileStabilityProbe ?? defaultFileStabilityProbe;
  const watchScheduler = input.watchScheduler ?? defaultWatchScheduler;
  const watchLock = await acquireWatchLock({
    repoPath: input.repoPath,
    watchedSavePath: config.watchedSavePath,
    now,
  });
  const watchEventSource = input.watchEventSource ?? nodeWatchEventSource;
  let subscription: WatchEventSubscription | undefined;
  let httpServer: ServerType | undefined;
  let http: LocalHistoryWatchProcess["http"];
  let changeLoop: Promise<void> | undefined;
  let deferredObservationTask: ScheduledWatchTask | undefined;
  const changeState = {
    dirty: false,
  };
  let stopped = false;
  const startedAt = now.toISOString();
  let activity: "idle" | "pending" | "observing" = "idle";
  let observationRevision = 0;
  let lastObservation: ReturnType<
    LocalHistoryWatchProcess["getWatcherStatus"]
  >["lastObservation"];

  try {
    await startAndObserve();
  } catch (error) {
    await cleanUpFailedStart();

    throw error;
  }

  async function startAndObserve() {
    await startComponents();

    emit({
      type: "started",
      repoPath: input.repoPath,
      watchedSavePath: config.watchedSavePath,
      capturePolicy: config.capturePolicy,
      ...(http !== undefined && { http }),
    });

    await observeAndEmit("startup", now);
  }

  async function cleanUpFailedStart() {
    deferredObservationTask?.cancel();

    if (subscription !== undefined) {
      await subscription.stop();
    }

    if (httpServer !== undefined) {
      await closeHttpServer(httpServer);
    }

    await watchLock.release();
  }

  async function startComponents() {
    subscription = await watchEventSource.start({
      watchedSavePath: config.watchedSavePath,
      onChange: async () => {
        await handleChangeEvent();
      },
      onError: async (error) => {
        await handleFatalWatchBackendError(error);
      },
    });

    if (input.http !== undefined) {
      if (!isLoopbackHost(config.localApi.host)) {
        throw new LocalHttpServerStartError();
      }

      // Buffer is required until this package's TypeScript lib includes the Uint8Array base64 API.
      // eslint-disable-next-line unicorn/prefer-uint8array-base64
      const token = randomBytes(32).toString("base64url");
      const app = createLocalHttpApp({
        repoPath: input.repoPath,
        token,
        getWatcherStatus: () => getWatcherStatus(),
        onRequestError: (error) => {
          emit({ type: "httpRequestError", repoPath: input.repoPath, error });
        },
      });
      const startedServer = await startHttpServer(
        app.fetch,
        input.http.port ?? 0,
      );

      httpServer = startedServer.server;
      if ("headersTimeout" in httpServer && "requestTimeout" in httpServer) {
        httpServer.headersTimeout = 10_000;
        httpServer.requestTimeout = 10_000;
      }
      http = { endpoint: startedServer.endpoint, token };
      httpServer.on("error", () => {
        handleFatalHttpServerError().catch(() => undefined);
      });
    }
  }

  return {
    repoPath: input.repoPath,
    ...(http !== undefined && { http }),
    getWatcherStatus: () => getWatcherStatus(),
    async stop() {
      await stopProcess();
    },
  };

  async function handleFatalWatchBackendError(error: unknown) {
    if (stopped) {
      return;
    }

    emit({
      type: "fatalError",
      repoPath: input.repoPath,
      error: {
        message: getErrorMessage(error),
        reason: "watchBackendFailure",
      },
    });

    await stopProcess();
  }

  async function handleFatalHttpServerError() {
    if (stopped) {
      return;
    }

    emit({
      type: "fatalError",
      repoPath: input.repoPath,
      error: {
        message: "Local HTTP Adapter failed.",
        reason: "httpServerFailure",
      },
    });
    await stopProcess();
  }

  async function stopProcess() {
    if (stopped) {
      return;
    }

    stopped = true;
    emit({
      type: "stopping",
      repoPath: input.repoPath,
    });
    deferredObservationTask?.cancel();
    deferredObservationTask = undefined;
    if (httpServer !== undefined) {
      await closeHttpServer(httpServer);
      httpServer = undefined;
    }
    if (subscription !== undefined) {
      await subscription.stop();
    }

    await changeLoop;

    await watchLock.release();
    emit({
      type: "stopped",
      repoPath: input.repoPath,
    });
  }

  async function observeAndEmit(
    cause: "startup" | "change" | "deferred",
    observedAt: Date,
  ): Promise<ObserveSaveResult> {
    activity = "observing";
    const result = await withHistoryWriteLock(
      input.repoPath,
      async () =>
        await observeSaveUsingConfig({
          config,
          repoPath: input.repoPath,
          observedAt,
          trigger: "watcher",
        }),
    );

    completeObservation(cause, result, observedAt);

    scheduleDeferredObservation(result);

    return result;
  }

  function scheduleDeferredObservation(result: ObserveSaveResult) {
    if (
      result.status !== "skipped"
      || result.reason !== "minimumCommitInterval"
      || deferredObservationTask !== undefined
      || stopped
    ) {
      return;
    }

    deferredObservationTask = watchScheduler.scheduleAt(
      new Date(result.nextAllowedAt),
      async () => {
        deferredObservationTask = undefined;

        if (!stopped) {
          await observeStableFile("deferred");
        }
      },
    );
    activity = "pending";
  }

  async function handleChangeEvent() {
    if (changeLoop !== undefined) {
      changeState.dirty = true;
      return;
    }

    changeLoop = runChangeLoop();

    try {
      await changeLoop;
    } finally {
      changeLoop = undefined;
    }
  }

  async function runChangeLoop() {
    changeState.dirty = false;
    await observeStableFile("change");

    if (isChangeDirty()) {
      await runChangeLoop();
    }
  }

  function isChangeDirty(): boolean {
    return changeState.dirty;
  }

  async function observeStableFile(cause: "change" | "deferred") {
    activity = "pending";
    try {
      await fileStabilityProbe.waitForStableFile(config.watchedSavePath);
    } catch (error) {
      completeObservation(
        cause,
        {
          status: "watcherError",
          error: {
            message: getErrorMessage(error),
            reason: "stabilityTimeout",
          },
        },
        input.now?.() ?? new Date(),
      );
      return;
    }

    await observeAndEmit(cause, input.now?.() ?? new Date());
  }

  function completeObservation(
    cause: "startup" | "change" | "deferred",
    result: ObserveSaveResult,
    completedAt: Date,
  ) {
    emit({
      type: "observation",
      repoPath: input.repoPath,
      cause,
      result,
    });
    observationRevision++;
    lastObservation = summarizeObservation(cause, result, completedAt);
    activity = "idle";
  }

  function getWatcherStatus() {
    return {
      status: "running" as const,
      activity,
      observationRevision,
      startedAt,
      repoPath: input.repoPath,
      watchedSavePath: config.watchedSavePath,
      capturePolicy: config.capturePolicy,
      ...(lastObservation !== undefined && { lastObservation }),
    };
  }
}

async function startHttpServer(
  fetch: Parameters<typeof serve>[0]["fetch"],
  port: number,
): Promise<{ readonly server: ServerType; readonly endpoint: string }> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new LocalHttpServerStartError();
  }

  try {
    return await new Promise((resolve, reject) => {
      const server = serve({ fetch, port, hostname: "127.0.0.1" }, (info) => {
        server.removeListener("error", reject);
        resolve({
          server,
          endpoint: `http://127.0.0.1:${info.port}`,
        });
      });

      server.once("error", reject);
    });
  } catch (error) {
    throw new LocalHttpServerStartError({ cause: error });
  }
}

function isLoopbackHost(host: unknown): host is "127.0.0.1" {
  return host === "127.0.0.1";
}

async function closeHttpServer(server: ServerType) {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function summarizeObservation(
  cause: "startup" | "change" | "deferred",
  result: ObserveSaveResult,
  completedAt: Date,
) {
  const common = { cause, completedAt: completedAt.toISOString() };

  if (result.status === "committed") {
    return {
      ...common,
      status: result.status,
      commit: result.observation.commit,
      eventCount:
        result.semanticUpdate.status === "updated"
          ? result.semanticUpdate.eventCount
          : 0,
      semanticStatus: result.semanticUpdate.status,
    } as const;
  }

  if (result.status === "skipped") {
    return {
      ...common,
      status: result.status,
      reason: result.reason,
      ...(result.reason === "minimumCommitInterval" && {
        nextAllowedAt: result.nextAllowedAt,
      }),
    } as const;
  }

  return { ...common, status: result.status, error: result.error } as const;
}

const nodeWatchEventSource: WatchEventSource = {
  start(input: WatchEventSourceStartInput): WatchEventSubscription {
    const watcher = watch(input.watchedSavePath, () => {
      handleWatchChange(input);
    });

    watcher.on("error", (error) => {
      handleWatchError(input, error);
    });

    return {
      stop() {
        watcher.close();
      },
    };
  },
};

function handleWatchChange(input: WatchEventSourceStartInput) {
  const change = runWatchChange(input);

  // Node fs.watch callbacks must return void; route async handler failures to the watch error
  // boundary instead of letting the Promise float.
  change.catch((error: unknown) => {
    handleWatchError(input, error);
  });
}

function handleWatchError(input: WatchEventSourceStartInput, error: unknown) {
  const handledError = input.onError(error);

  if (handledError instanceof Promise) {
    handledError.catch(() => undefined);
  }
}

async function runWatchChange(input: WatchEventSourceStartInput) {
  await input.onChange();
}

const defaultWatchScheduler: WatchScheduler = {
  scheduleAt(runAt: Date, task: () => void | Promise<void>) {
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    const timeout = setTimeout(() => {
      const taskResult = task();

      if (taskResult instanceof Promise) {
        taskResult.catch(() => undefined);
      }
    }, delayMs);

    return {
      cancel() {
        clearTimeout(timeout);
      },
    };
  },
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultFileStabilityProbe: FileStabilityProbe = {
  async waitForStableFile(filePath: string) {
    let previous = await stat(filePath);

    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      const current = await stat(filePath);

      if (
        current.size === previous.size
        && current.mtimeMs === previous.mtimeMs
      ) {
        return;
      }

      previous = current;
    }

    throw new Error("Watched Save did not become stable.");
  },
};
