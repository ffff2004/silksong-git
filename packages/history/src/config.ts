import { readFile } from "node:fs/promises";

import { getRepositoryLayout } from "./layout.ts";
import type { InitSaveHistoryInput } from "./types.ts";

interface ProjectConfig {
  readonly watchedSavePath: string;
  readonly capturePolicy: {
    readonly debounceWriteMs: number;
    readonly minCommitIntervalMs: number;
  };
  readonly displaySemanticEventFilters: {
    readonly hideEventTypes: readonly string[];
    readonly hideItemTypes: readonly string[];
    readonly hideSummaryMetrics: readonly string[];
    readonly minJournalDelta?: number;
    readonly hideCurrencyOnlyEvents: boolean;
  };
  readonly restore: {
    readonly backupDirectory?: string;
  };
  readonly localUi: {
    readonly host: "127.0.0.1";
    readonly port?: number;
  };
}

export function createProjectConfig(
  input: InitSaveHistoryInput,
): ProjectConfig {
  return {
    watchedSavePath: input.watchedSavePath,
    capturePolicy: {
      debounceWriteMs: 500,
      minCommitIntervalMs: 0,
    },
    displaySemanticEventFilters: {
      hideEventTypes: [],
      hideItemTypes: [],
      hideSummaryMetrics: ["rosaries", "shellShards", "playTime"],
      hideCurrencyOnlyEvents: true,
    },
    restore: {},
    localUi: {
      host: "127.0.0.1",
    },
    ...input.config,
  };
}

export async function readProjectConfig(
  repoPath: string,
): Promise<ProjectConfig> {
  const configJson = await readFile(
    getRepositoryLayout(repoPath).configPath,
    "utf8",
  );

  return JSON.parse(configJson) as ProjectConfig;
}
