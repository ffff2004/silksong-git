import { readFile } from "node:fs/promises";

import { getRepositoryLayout } from "./layout.ts";
import type { InitSaveHistoryInput, ProjectConfig } from "./types.ts";

export function createProjectConfig(
  input: InitSaveHistoryInput,
): ProjectConfig {
  const overrides = input.config ?? {};

  return {
    watchedSavePath: input.watchedSavePath,
    capturePolicy: {
      debounceWriteMs: 500,
      minCommitIntervalMs: 0,
      ...overrides.capturePolicy,
    },
    displaySemanticEventFilters: {
      hideEventTypes: [],
      hideItemTypes: [],
      hideSummaryMetrics: ["rosaries", "shellShards", "playTime"],
      hideCurrencyOnlyEvents: true,
      ...overrides.displaySemanticEventFilters,
    },
    restore: {
      ...overrides.restore,
    },
    localApi: {
      host: overrides.localApi?.host ?? "127.0.0.1",
    },
  };
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return `${JSON.stringify(config, undefined, 2)}\n`;
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
