import type { Stats } from "node:fs";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import type {
  FileStabilityProbe,
  LocalHistoryApiProcess,
  StartLocalHistoryApiProcessInput,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
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
  const watchLock = await acquireWatchLock({
    repoPath: input.repoPath,
    watchedSavePath: config.watchedSavePath,
    now,
  });
  const watchEventSource = input.watchEventSource ?? nodeWatchEventSource;
  let subscription: WatchEventSubscription | undefined;

  try {
    subscription = await watchEventSource.start({
      watchedSavePath: config.watchedSavePath,
      onChange: async () => {
        await fileStabilityProbe.waitForStableFile(config.watchedSavePath);
        await observeAndEmit("change", input.now?.() ?? new Date());
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
    if (subscription !== undefined) {
      await subscription.stop();
    }

    await watchLock.release();

    throw error;
  }

  let stopped = false;

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
  ) {
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
  // eslint-disable-next-line unicorn/prefer-await
  change.catch(input.onError);
}

async function runWatchChange(input: WatchEventSourceStartInput) {
  await input.onChange();
}

const defaultFileStabilityProbe: FileStabilityProbe = {
  async waitForStableFile(filePath: string) {
    await waitForStableProbe(filePath, await stat(filePath), 0);
  },
};

async function waitForStableProbe(
  filePath: string,
  previous: Stats,
  attempt: number,
) {
  if (attempt >= 20) {
    throw new Error("Watched Save did not become stable.");
  }

  await sleep(100);
  const current = await stat(filePath);

  if (current.size === previous.size && current.mtimeMs === previous.mtimeMs) {
    return;
  }

  await waitForStableProbe(filePath, current, attempt + 1);
}
