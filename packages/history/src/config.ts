import { isArray } from "complete-common";
import { readFile } from "node:fs/promises";

import { getRepositoryLayout } from "./layout.ts";
import type { InitSaveHistoryInput, ProjectConfig } from "./types.ts";

export const currentRepositoryFormatVersion = 1;

export function createProjectConfig(
  input: InitSaveHistoryInput,
): ProjectConfig {
  const overrides = input.config ?? {};

  return {
    repositoryFormatVersion: currentRepositoryFormatVersion,
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

  return parseCurrentProjectConfig(configJson);
}

export function parseProjectConfig(configJson: string):
  | { readonly status: "current"; readonly config: ProjectConfig }
  | {
      readonly status: "legacy";
      readonly config: Omit<ProjectConfig, "repositoryFormatVersion">;
    }
  | {
      readonly status: "migrationRequired";
      readonly config: Omit<ProjectConfig, "repositoryFormatVersion">;
    }
  | { readonly status: "newerIncompatible" }
  | { readonly status: "invalid" } {
  let value: unknown;

  try {
    value = JSON.parse(configJson) as unknown;
  } catch {
    return { status: "invalid" };
  }

  if (!isProjectConfigRecord(value)) {
    return { status: "invalid" };
  }

  const { repositoryFormatVersion } = value;
  if (repositoryFormatVersion === undefined) {
    return { status: "legacy", config: toUnversionedProjectConfig(value) };
  }
  if (
    typeof repositoryFormatVersion !== "number"
    || !Number.isSafeInteger(repositoryFormatVersion)
    || repositoryFormatVersion < 0
  ) {
    return { status: "invalid" };
  }
  if (repositoryFormatVersion < currentRepositoryFormatVersion) {
    return {
      status: "migrationRequired",
      config: toUnversionedProjectConfig(value),
    };
  }
  if (repositoryFormatVersion > currentRepositoryFormatVersion) {
    return { status: "newerIncompatible" };
  }

  return {
    status: "current",
    config: {
      repositoryFormatVersion,
      ...toUnversionedProjectConfig(value),
    },
  };
}

function parseCurrentProjectConfig(configJson: string): ProjectConfig {
  const parsed = parseProjectConfig(configJson);

  if (parsed.status === "current") {
    return parsed.config;
  }

  throw new Error("Save History Repository Project Config is not current.");
}

function isProjectConfigRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (
    !isRecord(value)
    || typeof value["watchedSavePath"] !== "string"
    || value["watchedSavePath"] === ""
  ) {
    return false;
  }
  if (!isCapturePolicy(value["capturePolicy"])) {
    return false;
  }
  if (!isDisplaySemanticEventFilters(value["displaySemanticEventFilters"])) {
    return false;
  }

  return isRestoreConfig(value["restore"]);
}

function toUnversionedProjectConfig(
  value: Readonly<Record<string, unknown>>,
): Omit<ProjectConfig, "repositoryFormatVersion"> {
  return {
    capturePolicy: value["capturePolicy"] as ProjectConfig["capturePolicy"],
    displaySemanticEventFilters: value[
      "displaySemanticEventFilters"
    ] as ProjectConfig["displaySemanticEventFilters"],
    restore: value["restore"] as ProjectConfig["restore"],
    watchedSavePath: value["watchedSavePath"] as string,
  };
}

function isCapturePolicy(
  value: unknown,
): value is ProjectConfig["capturePolicy"] {
  return (
    isRecord(value)
    && isNonNegativeSafeInteger(value["debounceWriteMs"])
    && isNonNegativeSafeInteger(value["minCommitIntervalMs"])
  );
}

function isDisplaySemanticEventFilters(
  value: unknown,
): value is ProjectConfig["displaySemanticEventFilters"] {
  return (
    isRecord(value)
    && isStringArray(value["hideEventTypes"])
    && isStringArray(value["hideItemTypes"])
    && isStringArray(value["hideSummaryMetrics"])
    && typeof value["hideCurrencyOnlyEvents"] === "boolean"
    && (value["minJournalDelta"] === undefined
      || (typeof value["minJournalDelta"] === "number"
        && Number.isFinite(value["minJournalDelta"])))
  );
}

function isRestoreConfig(value: unknown): value is ProjectConfig["restore"] {
  return (
    isRecord(value)
    && (value["backupDirectory"] === undefined
      || typeof value["backupDirectory"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
