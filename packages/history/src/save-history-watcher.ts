import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import {
  assertRepositoryCapability,
  withRepositoryWriteCapability,
} from "./repository-compatibility.ts";
import type {
  AcquireSaveHistoryWatcherInput,
  ObserveSaveHistoryWatcherInput,
  ObserveSaveResult,
  ProjectConfig,
  SaveHistoryWatcher,
} from "./types.ts";
import { acquireWatchLock } from "./watch-lock.ts";

export async function acquireSaveHistoryWatcher(
  input: AcquireSaveHistoryWatcherInput,
): Promise<SaveHistoryWatcher> {
  await assertRepositoryCapability(input.repoPath, "watch");
  const config = snapshotProjectConfig(await readProjectConfig(input.repoPath));
  const watchLock = await acquireWatchLock({
    repoPath: input.repoPath,
    watchedSavePath: config.watchedSavePath,
    now: input.startedAt ?? new Date(),
  });
  const activeObservations = new Set<Promise<ObserveSaveResult>>();
  let closing = false;
  let releasePromise: Promise<void> | undefined;

  return Object.freeze({
    watchedSavePath: config.watchedSavePath,
    capturePolicy: config.capturePolicy,
    async observe(
      observeInput: ObserveSaveHistoryWatcherInput,
    ): Promise<ObserveSaveResult> {
      if (closing) {
        throw new Error("Save History Watcher is closing.");
      }

      const observation = withRepositoryWriteCapability(
        input.repoPath,
        "observe",
        async () =>
          await observeSaveUsingConfig({
            config,
            repoPath: input.repoPath,
            observedAt: observeInput.observedAt,
            trigger: "watcher",
          }),
      );
      activeObservations.add(observation);

      try {
        return await observation;
      } finally {
        activeObservations.delete(observation);
      }
    },
    async release() {
      if (releasePromise === undefined) {
        closing = true;
        releasePromise = releaseWatcher();
      }

      await releasePromise;
    },
  });

  async function releaseWatcher() {
    await Promise.allSettled(activeObservations);
    await watchLock.release();
  }
}

function snapshotProjectConfig(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    capturePolicy: Object.freeze({ ...config.capturePolicy }),
    displaySemanticEventFilters: {
      ...config.displaySemanticEventFilters,
      hideEventTypes: [...config.displaySemanticEventFilters.hideEventTypes],
      hideItemTypes: [...config.displaySemanticEventFilters.hideItemTypes],
      hideSummaryMetrics: [
        ...config.displaySemanticEventFilters.hideSummaryMetrics,
      ],
    },
    restore: { ...config.restore },
  };
}
