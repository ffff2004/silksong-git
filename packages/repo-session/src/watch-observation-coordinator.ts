import type { ObserveSaveResult } from "@silksong-git/history";
import type {
  FileStabilityProbe,
  ScheduledWatchTask,
  WatchScheduler,
} from "./types.ts";

type WatchObservationCause = "startup" | "change" | "deferred";

type WatchObservationActivity = "idle" | "pending" | "observing";

interface WatchObservationCoordinatorInput {
  readonly watchedSavePath: string;
  readonly debounceWriteMs: number;
  readonly fileStabilityProbe: FileStabilityProbe;
  readonly watchScheduler: WatchScheduler;
  readonly now: () => Date;
  readonly observe: (
    cause: WatchObservationCause,
    observedAt: Date,
  ) => Promise<ObserveSaveResult>;
  readonly complete: (
    cause: WatchObservationCause,
    result: ObserveSaveResult,
    completedAt: Date,
  ) => void;
  readonly setActivity: (activity: WatchObservationActivity) => void;
  readonly onUnexpectedError: (error: unknown) => void;
}

export interface WatchObservationCoordinator {
  start: () => Promise<void>;
  notifyChange: () => void | Promise<void>;
  stop: () => Promise<void>;
}

export function createWatchObservationCoordinator(
  input: WatchObservationCoordinatorInput,
): WatchObservationCoordinator {
  const startupCompleted = Promise.withResolvers<undefined>();
  let startupPending = false;
  let startupSettled = false;
  let latestChangeAt: Date | undefined;
  let deferredNotBefore: Date | undefined;
  let activeRun: Promise<void> | undefined;
  let scheduledTask: ScheduledWatchTask | undefined;
  let scheduledAt: number | undefined;
  let timerEpoch = 0;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;

  return {
    async start() {
      startupPending = true;
      await scheduleWork();

      await startupCompleted.promise;
    },
    async notifyChange() {
      if (stopping) {
        return;
      }

      latestChangeAt = input.now();

      return await scheduleWork();
    },
    async stop() {
      if (stopPromise !== undefined) {
        await stopPromise;
        return;
      }

      stopping = true;
      cancelScheduledWork();
      startupPending = false;
      latestChangeAt = undefined;
      deferredNotBefore = undefined;
      stopPromise = finishStopping();

      await stopPromise;
    },
  };

  async function finishStopping() {
    await activeRun;
    input.setActivity("idle");
  }

  function scheduleWork(): Promise<void> | undefined {
    if (stopping) {
      return undefined;
    }

    if (activeRun !== undefined) {
      return activeRun;
    }

    const next = getNextObservation();

    if (next === undefined) {
      input.setActivity("idle");
      return undefined;
    }

    if (next.runAt <= input.now().getTime()) {
      return startWorker();
    }

    scheduleWorkerAt(next.runAt);
    return undefined;
  }

  function getNextObservation():
    | { readonly cause: WatchObservationCause; readonly runAt: number }
    | undefined {
    if (startupPending) {
      return { cause: "startup", runAt: input.now().getTime() };
    }

    const deferredRunAt = deferredNotBefore?.getTime();
    const changeRunAt =
      latestChangeAt?.getTime() === undefined
        ? undefined
        : latestChangeAt.getTime() + input.debounceWriteMs;

    if (deferredRunAt === undefined && changeRunAt === undefined) {
      return undefined;
    }

    if (deferredRunAt === undefined) {
      return { cause: "change", runAt: changeRunAt ?? 0 };
    }

    if (changeRunAt === undefined) {
      return { cause: "deferred", runAt: deferredRunAt };
    }

    return {
      cause: "deferred",
      runAt: Math.max(deferredRunAt, changeRunAt),
    };
  }

  function scheduleWorkerAt(runAt: number) {
    if (scheduledAt === runAt && scheduledTask !== undefined) {
      return;
    }

    cancelScheduledWork();
    input.setActivity("pending");
    const timerEpochAtSchedule = timerEpoch;

    scheduledTask = input.watchScheduler.scheduleAt(
      new Date(runAt),
      async () => {
        if (timerEpochAtSchedule !== timerEpoch || stopping) {
          return;
        }

        scheduledTask = undefined;
        scheduledAt = undefined;
        await startWorker();
      },
    );
    scheduledAt = runAt;
  }

  function cancelScheduledWork() {
    timerEpoch++;
    scheduledTask?.cancel();
    scheduledTask = undefined;
    scheduledAt = undefined;
  }

  async function startWorker() {
    cancelScheduledWork();
    const worker = runWorker();
    const trackedWorker = worker
      .catch((error: unknown) => {
        if (!startupSettled) {
          startupSettled = true;
          startupCompleted.reject(error);
          return;
        }

        input.onUnexpectedError(error);
      })
      .finally(() => {
        if (activeRun === trackedWorker) {
          activeRun = undefined;
        }

        scheduleWork()?.catch(input.onUnexpectedError);
      });

    activeRun = trackedWorker;

    await trackedWorker;
  }

  async function runWorker() {
    for (;;) {
      if (stopping) {
        return;
      }

      const cause = takeReadyObservation();

      if (cause === undefined) {
        return;
      }

      await runObservation(cause);
    }
  }

  function takeReadyObservation(): WatchObservationCause | undefined {
    if (startupPending) {
      startupPending = false;

      return "startup";
    }

    const next = getNextObservation();

    if (next === undefined || next.runAt > input.now().getTime()) {
      return undefined;
    }

    latestChangeAt = undefined;
    deferredNotBefore = undefined;

    return next.cause;
  }

  async function runObservation(cause: WatchObservationCause) {
    input.setActivity("pending");

    try {
      await input.fileStabilityProbe.waitForStableFile(input.watchedSavePath);
    } catch (error) {
      input.complete(
        cause,
        {
          status: "watcherError",
          error: {
            message: getErrorMessage(error),
            reason: "stabilityTimeout",
          },
        },
        input.now(),
      );
      settleStartup(cause);

      return;
    }

    input.setActivity("observing");
    const observedAt = input.now();
    const result = await input.observe(cause, observedAt);

    input.complete(cause, result, observedAt);

    if (
      result.status === "skipped"
      && result.reason === "minimumCommitInterval"
    ) {
      deferredNotBefore = new Date(result.nextAllowedAt);
    }

    settleStartup(cause);
  }

  function settleStartup(cause: WatchObservationCause) {
    if (cause !== "startup" || startupSettled) {
      return;
    }

    startupSettled = true;
    startupCompleted.resolve(undefined);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
