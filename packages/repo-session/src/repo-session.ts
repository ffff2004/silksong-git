import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { ObserveSaveResult } from "@silksong-git/history";
import { acquireSaveHistoryWatcher } from "@silksong-git/history";

import { RepoSessionHttpServerStartError } from "./errors.ts";
import { createLocalHttpApp } from "./http-app.ts";
import type {
  FileStabilityProbe,
  RepoSession,
  StartRepoSessionInput,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
} from "./types.ts";
import { createWatchObservationCoordinator } from "./watch-observation-coordinator.ts";

export async function startRepoSession(
  input: StartRepoSessionInput,
): Promise<RepoSession> {
  const emit = input.onEvent ?? (() => undefined);
  const now = input.runtime?.now?.() ?? new Date();
  const watcher = await acquireSaveHistoryWatcher({
    repoPath: input.repoPath,
    startedAt: now,
  });
  const fileStabilityProbe =
    input.runtime?.fileStabilityProbe ?? defaultFileStabilityProbe;
  const watchScheduler = input.runtime?.watchScheduler ?? defaultWatchScheduler;
  const watchEventSource =
    input.runtime?.watchEventSource ?? nodeWatchEventSource;
  let subscription: WatchEventSubscription | undefined;
  let httpServer: ServerType | undefined;
  let http: RepoSession["http"];
  let stopped = false;
  const startedAt = now.toISOString();
  let activity: "idle" | "pending" | "observing" = "idle";
  let observationRevision = 0;
  let lastObservation: ReturnType<
    RepoSession["getWatcherStatus"]
  >["lastObservation"];
  const observationCoordinator = createWatchObservationCoordinator({
    watchedSavePath: watcher.watchedSavePath,
    debounceWriteMs: watcher.capturePolicy.debounceWriteMs,
    fileStabilityProbe,
    watchScheduler,
    now: () => input.runtime?.now?.() ?? new Date(),
    observe: observeAndEmit,
    complete: completeObservation,
    setActivity: (nextActivity) => {
      activity = nextActivity;
    },
    onUnexpectedError: (error) => {
      handleFatalWatchBackendError(error).catch(() => undefined);
    },
  });

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
      watchedSavePath: watcher.watchedSavePath,
      capturePolicy: watcher.capturePolicy,
      ...(http !== undefined && { http }),
    });

    await observationCoordinator.start();
  }

  async function cleanUpFailedStart() {
    await observationCoordinator.stop();

    if (subscription !== undefined) {
      await subscription.stop();
    }

    if (httpServer !== undefined) {
      await closeHttpServer(httpServer);
    }

    await watcher.release();
  }

  async function startComponents() {
    subscription = await watchEventSource.start({
      watchedSavePath: watcher.watchedSavePath,
      onChange: async () => {
        await observationCoordinator.notifyChange();
      },
      onError: async (error) => {
        await handleFatalWatchBackendError(error);
      },
    });

    if (input.http !== undefined) {
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
    const observationStop = observationCoordinator.stop();
    if (httpServer !== undefined) {
      await closeHttpServer(httpServer);
      httpServer = undefined;
    }
    if (subscription !== undefined) {
      await subscription.stop();
    }

    await observationStop;

    await watcher.release();
    emit({
      type: "stopped",
      repoPath: input.repoPath,
    });
  }

  async function observeAndEmit(
    _cause: "startup" | "change" | "deferred",
    observedAt: Date,
  ): Promise<ObserveSaveResult> {
    return await watcher.observe({ observedAt });
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
      watchedSavePath: watcher.watchedSavePath,
      capturePolicy: watcher.capturePolicy,
      ...(lastObservation !== undefined && { lastObservation }),
    };
  }
}

async function startHttpServer(
  fetch: Parameters<typeof serve>[0]["fetch"],
  port: number,
): Promise<{ readonly server: ServerType; readonly endpoint: string }> {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RepoSessionHttpServerStartError();
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
    throw new RepoSessionHttpServerStartError({ cause: error });
  }
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
