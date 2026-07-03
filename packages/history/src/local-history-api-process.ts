import { watch } from "node:fs";

import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import type {
  LocalHistoryApiProcess,
  StartLocalHistoryApiProcessInput,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
} from "./types.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export async function startLocalHistoryApiProcess(
  input: StartLocalHistoryApiProcessInput,
): Promise<LocalHistoryApiProcess> {
  const config = await readProjectConfig(input.repoPath);
  const emit = input.onEvent ?? (() => undefined);
  const watchEventSource = input.watchEventSource ?? nodeWatchEventSource;
  const subscription = await watchEventSource.start({
    watchedSavePath: config.watchedSavePath,
    onChange: () => {
      // Later P5-T5 slices route real change events through debounce, stability, and single-flight
      // observation.
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

  const startupResult = await withHistoryWriteLock(
    input.repoPath,
    async () =>
      await observeSaveUsingConfig({
        config,
        repoPath: input.repoPath,
        observedAt: input.now?.() ?? new Date(),
        trigger: "watcher",
      }),
  );

  emit({
    type: "observation",
    repoPath: input.repoPath,
    cause: "startup",
    result: startupResult,
  });

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
      stopped = true;
      emit({
        type: "stopped",
        repoPath: input.repoPath,
      });
    },
  };
}

const nodeWatchEventSource: WatchEventSource = {
  start(input: WatchEventSourceStartInput): WatchEventSubscription {
    const watcher = watch(input.watchedSavePath, () => {
      input.onChange();
    });

    watcher.on("error", input.onError);

    return {
      stop() {
        watcher.close();
      },
    };
  },
};
