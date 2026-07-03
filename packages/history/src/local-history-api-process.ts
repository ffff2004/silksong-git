import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import type {
  FileStabilityProbe,
  LocalHistoryApiProcess,
  ObserveSaveResult,
  ScheduledWatchTask,
  StartLocalHistoryApiProcessInput,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
} from "./types.ts";
import { acquireWatchLock } from "./watch-lock.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export async function startLocalHistoryApiProcess(
  input: StartLocalHistoryApiProcessInput,
): Promise<LocalHistoryApiProcess> {
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
  let changeLoop: Promise<void> | undefined;
  let deferredObservationTask: ScheduledWatchTask | undefined;
  const changeState = {
    dirty: false,
  };
  let stopped = false;

  try {
    subscription = await watchEventSource.start({
      watchedSavePath: config.watchedSavePath,
      onChange: async () => {
        await handleChangeEvent();
      },
      onError: () => {
        // Later P5-T5 slices classify backend errors as fatal process errors.
      },
    });

    emit({
      type: "started",
      repoPath: input.repoPath,
      watchedSavePath: config.watchedSavePath,
      capturePolicy: config.capturePolicy,
    });

    await observeAndEmit("startup", now);
  } catch (error) {
    deferredObservationTask?.cancel();

    if (subscription !== undefined) {
      await subscription.stop();
    }

    await watchLock.release();

    throw error;
  }

  return {
    repoPath: input.repoPath,
    async stop() {
      if (stopped) {
        return;
      }

      emit({
        type: "stopping",
        repoPath: input.repoPath,
      });
      deferredObservationTask?.cancel();
      deferredObservationTask = undefined;
      await subscription.stop();
      await watchLock.release();
      stopped = true;
      emit({
        type: "stopped",
        repoPath: input.repoPath,
      });
    },
  };

  async function observeAndEmit(
    cause: "startup" | "change" | "deferred",
    observedAt: Date,
  ): Promise<ObserveSaveResult> {
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

    emit({
      type: "observation",
      repoPath: input.repoPath,
      cause,
      result,
    });

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
    try {
      await fileStabilityProbe.waitForStableFile(config.watchedSavePath);
    } catch (error) {
      emit({
        type: "observation",
        repoPath: input.repoPath,
        cause,
        result: {
          status: "watcherError",
          error: {
            message: getErrorMessage(error),
            reason: "stabilityTimeout",
          },
        },
      });
      return;
    }

    await observeAndEmit(cause, input.now?.() ?? new Date());
  }
}

const nodeWatchEventSource: WatchEventSource = {
  start(input: WatchEventSourceStartInput): WatchEventSubscription {
    const watcher = watch(input.watchedSavePath, () => {
      handleWatchChange(input);
    });

    watcher.on("error", input.onError);

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
  change.catch(input.onError);
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
