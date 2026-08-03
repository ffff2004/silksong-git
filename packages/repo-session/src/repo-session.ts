import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  ObserveSaveResult,
  SaveHistoryWatcher,
} from "@silksong-git/history";
import {
  acquireSaveHistoryWatcher,
  inspectSaveHistoryRepository,
  SaveHistoryRepositoryIncompatibleError,
} from "@silksong-git/history";

import { RepoSessionHttpServerStartError } from "./errors.ts";
import { createLocalHttpApp } from "./http-app.ts";
import type {
  FileStabilityProbe,
  OpenRepoSessionInput,
  RepoSession,
  RepoSessionObservationSummary,
  RepoSessionWatcherStatus,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
} from "./types.ts";
import type { WatchObservationCoordinator } from "./watch-observation-coordinator.ts";
import { createWatchObservationCoordinator } from "./watch-observation-coordinator.ts";

export async function openRepoSession(
  input: OpenRepoSessionInput,
): Promise<RepoSession> {
  const access = input.access ?? "readWrite";
  const inspection = await inspectSaveHistoryRepository({
    repoPath: input.repoPath,
    gitIntegrityPolicy: access === "readOnly" ? "advisory" : "strict",
  });
  if (
    inspection.status !== "ready"
    && !(
      access === "readOnly"
      && (inspection.status === "legacyConfig"
        || inspection.status === "migrationRequired")
    )
  ) {
    throw new SaveHistoryRepositoryIncompatibleError({
      status: inspection.status,
      requiredAction: inspection.requiredAction,
      capabilities: inspection.capabilities,
    });
  }

  const emit = input.onEvent ?? (() => undefined);
  const admission = createHttpAdmission();
  let watcherState: RepoSessionWatcherStatus["status"] = "inactive";
  let watcher: SaveHistoryWatcher | undefined;
  let subscription: WatchEventSubscription | undefined;
  let observationCoordinator: WatchObservationCoordinator | undefined;
  let watcherStartedAt: string | undefined;
  let activity: "idle" | "pending" | "observing" = "idle";
  let observationRevision = 0;
  let lastObservation: RepoSessionObservationSummary | undefined;
  let lifecycleTail = Promise.resolve();
  let stopRequested = false;
  let stopPromise: Promise<void> | undefined;

  // Buffer is required until this package's TypeScript lib includes the Uint8Array base64 API.
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  const token = randomBytes(32).toString("base64url");
  const app = createLocalHttpApp({
    repoPath: input.repoPath,
    token,
    getWatcherStatus,
    admission,
    canMutate: access === "readWrite",
    historyAccess: access === "readOnly" ? "readOnly" : undefined,
    onRequestError: (error) => {
      emit({ type: "httpRequestError", repoPath: input.repoPath, error });
    },
    onMutationActivity: (mutationActivity) => {
      emit({
        type: "mutationActivity",
        repoPath: input.repoPath,
        ...mutationActivity,
      });
    },
  });
  const startedServer = await startHttpServer(app.fetch, input.port ?? 0);
  let httpServer: ServerType | undefined = startedServer.server;
  if ("headersTimeout" in httpServer && "requestTimeout" in httpServer) {
    httpServer.headersTimeout = 10_000;
    httpServer.requestTimeout = 10_000;
  }
  const http = { endpoint: startedServer.endpoint, token };
  const session: RepoSession = {
    repoPath: input.repoPath,
    access,
    http,
    getWatcherStatus,
    startWatching: async () => {
      if (access === "readOnly") {
        throw new Error("This Repo Session is read-only.");
      }
      await linearize(startWatching);
    },
    stopWatching: async () => {
      if (access === "readOnly") {
        throw new Error("This Repo Session is read-only.");
      }
      await linearize(stopWatching);
    },
    stop,
  };

  httpServer.on("error", () => {
    handleFatalHttpServerError().catch(() => undefined);
  });

  return session;

  async function linearize(operation: () => Promise<void>) {
    const result = lifecycleTail.then(operation, operation);
    lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );

    await result;
  }

  async function startWatching() {
    if (stopRequested) {
      throw new Error("Repo Session is stopping.");
    }
    if (watcherState === "running") {
      return;
    }
    if (watcherState !== "inactive") {
      throw new Error(
        `Cannot start watching while watcher is ${watcherState}.`,
      );
    }

    watcherState = "starting";
    const startedAt = input.runtime?.now?.() ?? new Date();
    let acquiredWatcher: SaveHistoryWatcher | undefined;
    let attachedSubscription: WatchEventSubscription | undefined;
    let coordinator: WatchObservationCoordinator | undefined;
    let startupBackendFailure: { readonly error: unknown } | undefined;

    try {
      await performStart();
    } catch (error) {
      await coordinator?.stop();
      await attachedSubscription?.stop();
      await acquiredWatcher?.release();
      clearWatcherRuntime();
      throw error;
    }

    async function performStart() {
      acquiredWatcher = await acquireSaveHistoryWatcher({
        repoPath: input.repoPath,
        startedAt,
      });
      coordinator = createCoordinator(acquiredWatcher);
      attachedSubscription = await (
        input.runtime?.watchEventSource ?? nodeWatchEventSource
      ).start({
        watchedSavePath: acquiredWatcher.watchedSavePath,
        onChange: async () => {
          await coordinator?.notifyChange();
        },
        onError: async (error) => {
          if (watcherState === "starting") {
            startupBackendFailure ??= { error };

            return;
          }

          await handleFatalWatchBackendError(error);
        },
      });
      if (startupBackendFailure !== undefined) {
        throw startupBackendFailure.error;
      }

      watcher = acquiredWatcher;
      subscription = attachedSubscription;
      observationCoordinator = coordinator;
      watcherStartedAt = startedAt.toISOString();
      activity = "idle";
      watcherState = "running";
      emit({
        type: "started",
        repoPath: input.repoPath,
        watchedSavePath: acquiredWatcher.watchedSavePath,
        capturePolicy: acquiredWatcher.capturePolicy,
      });
      await coordinator.start();
    }
  }

  function createCoordinator(acquiredWatcher: SaveHistoryWatcher) {
    return createWatchObservationCoordinator({
      watchedSavePath: acquiredWatcher.watchedSavePath,
      debounceWriteMs: acquiredWatcher.capturePolicy.debounceWriteMs,
      fileStabilityProbe:
        input.runtime?.fileStabilityProbe ?? defaultFileStabilityProbe,
      watchScheduler: input.runtime?.watchScheduler ?? defaultWatchScheduler,
      now: () => input.runtime?.now?.() ?? new Date(),
      observe: async (_cause, observedAt) =>
        await acquiredWatcher.observe({ observedAt }),
      complete: completeObservation,
      setActivity: (nextActivity) => {
        activity = nextActivity;
      },
      onUnexpectedError: (error) => {
        handleFatalWatchBackendError(error).catch(() => undefined);
      },
    });
  }

  async function stopWatching() {
    if (watcherState === "inactive") {
      return;
    }
    if (watcherState !== "running") {
      throw new Error(`Cannot stop watching while watcher is ${watcherState}.`);
    }

    await stopWatcherRuntime(true);
  }

  async function stopWatcherRuntime(releaseWatcher: boolean) {
    watcherState = "stopping";
    const coordinator = observationCoordinator;
    const currentSubscription = subscription;
    const currentWatcher = watcher;
    const observationDrain = coordinator?.stop() ?? Promise.resolve();

    await currentSubscription?.stop();
    await observationDrain;
    if (releaseWatcher) {
      await currentWatcher?.release();
      clearWatcherRuntime();
    }
  }

  function clearWatcherRuntime() {
    watcher = undefined;
    subscription = undefined;
    observationCoordinator = undefined;
    watcherStartedAt = undefined;
    activity = "idle";
    watcherState = "inactive";
  }

  async function stop() {
    if (stopPromise !== undefined) {
      await stopPromise;

      return;
    }

    stopRequested = true;
    admission.stop();
    stopPromise = linearize(stopSession);
    emit({ type: "stopping", repoPath: input.repoPath });

    await stopPromise;
  }

  async function stopSession() {
    if (httpServer === undefined) {
      return;
    }

    const closingServer = closeHttpServer(httpServer);
    const currentWatcher = watcher;

    if (watcherState === "running") {
      await stopWatcherRuntime(false);
    }
    await admission.drain();
    await currentWatcher?.release();
    clearWatcherRuntime();
    await closingServer;
    httpServer = undefined;
    emit({ type: "stopped", repoPath: input.repoPath });
  }

  async function handleFatalWatchBackendError(error: unknown) {
    if (stopRequested || watcherState !== "running") {
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
    await linearize(async () => {
      if (watcherState === "running") {
        await stopWatcherRuntime(true);
      }
    });
  }

  async function handleFatalHttpServerError() {
    if (stopRequested || httpServer === undefined) {
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
    await stop();
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

  function getWatcherStatus(): RepoSessionWatcherStatus {
    const common = {
      repoPath: input.repoPath,
      observationRevision,
      ...(lastObservation !== undefined && { lastObservation }),
    };

    const activeWatcher = watcher;
    const activeStartedAt = watcherStartedAt;

    if (
      (watcherState === "running" || watcherState === "stopping")
      && activeWatcher !== undefined
      && activeStartedAt !== undefined
    ) {
      return {
        ...common,
        status: watcherState,
        activity,
        startedAt: activeStartedAt,
        watchedSavePath: activeWatcher.watchedSavePath,
        capturePolicy: activeWatcher.capturePolicy,
      };
    }

    if (watcherState === "inactive" || watcherState === "starting") {
      return { ...common, status: watcherState };
    }

    throw new Error("Watcher lifecycle state is inconsistent.");
  }
}

interface HttpAdmission {
  readonly isOpen: () => boolean;
  readonly track: (work: Promise<unknown>) => void;
  readonly stop: () => void;
  readonly drain: () => Promise<void>;
}

function createHttpAdmission(): HttpAdmission {
  const active = new Set<Promise<unknown>>();
  let open = true;

  return {
    isOpen: () => open,
    track(work) {
      active.add(work);
      work
        .finally(() => {
          active.delete(work);
        })
        .catch(() => undefined);
    },
    stop() {
      open = false;
    },
    async drain() {
      while (active.size > 0) {
        await Promise.allSettled(active);
      }
    },
  };
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
        resolve({ server, endpoint: `http://127.0.0.1:${info.port}` });
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
): RepoSessionObservationSummary {
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
    };
  }

  if (result.status === "skipped") {
    return {
      ...common,
      status: result.status,
      reason: result.reason,
      ...(result.reason === "minimumCommitInterval" && {
        nextAllowedAt: result.nextAllowedAt,
      }),
    };
  }

  return { ...common, status: result.status, error: result.error };
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
  const change = input.onChange();
  if (change instanceof Promise) {
    change.catch((error: unknown) => {
      handleWatchError(input, error);
    });
  }
}

function handleWatchError(input: WatchEventSourceStartInput, error: unknown) {
  const handledError = input.onError(error);
  if (handledError instanceof Promise) {
    handledError.catch(() => undefined);
  }
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
      cancel: () => {
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
