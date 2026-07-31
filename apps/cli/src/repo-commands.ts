import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  MigrateSaveHistoryRepositoryResult,
  SaveHistoryRepositoryInspection,
} from "@silksong-git/history";
import {
  initSaveHistory,
  inspectSaveHistoryRepository,
  migrateSaveHistoryRepository,
} from "@silksong-git/history";
import type { Command } from "commander";

import type { CliRuntime } from "./cli-runtime.ts";
import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";

interface InitCommandOptions {
  readonly save?: string;
  readonly repo?: string;
  readonly json?: boolean;
}

interface InspectCommandOptions {
  readonly repo?: string;
  readonly json?: boolean;
}

interface MigrateCommandOptions extends InspectCommandOptions {
  readonly confirmMigration?: boolean;
}

interface SafeRepositoryInspection {
  readonly status: SaveHistoryRepositoryInspection["status"];
  readonly requiredAction: SaveHistoryRepositoryInspection["requiredAction"];
  readonly capabilities: readonly string[];
}

type SafeMigrationResult =
  | {
      readonly status: "migrated";
      readonly inspection: SafeRepositoryInspection;
      readonly backupCreated: true;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "confirmationRequired"
        | "staleInspection"
        | "migrationNotRequired";
      readonly inspection: SafeRepositoryInspection;
    }
  | {
      readonly status: "failed";
      readonly reason: "backupFailed" | "repositoryBusy" | "migrationFailed";
      readonly inspection: SafeRepositoryInspection;
    };

export function registerRepoCommands(
  program: Command,
  runtime: CliRuntime,
): void {
  const repoCommand = program.command("repo");

  repoCommand
    .command("init")
    .requiredOption("--save <save.dat>")
    .requiredOption("--repo <history-repo>")
    .option("--json")
    .action(async (options: InitCommandOptions) => {
      await runInitCommand(options, runtime);
    });

  repoCommand
    .command("inspect")
    .requiredOption("--repo <history-repo>")
    .option("--json")
    .action(async (options: InspectCommandOptions) => {
      await runInspectCommand(options, runtime);
    });

  repoCommand
    .command("migrate")
    .requiredOption("--repo <history-repo>")
    .option("--confirm-migration")
    .option("--json")
    .action(async (options: MigrateCommandOptions) => {
      await runMigrateCommand(options, runtime);
    });
}

async function runInitCommand(
  options: InitCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runInitCommandOrThrow(options, runtime);
  } catch (error) {
    if (error instanceof RepoInitUsageError) {
      runtime.writeStderr(`${error.message}\n`);
      runtime.setExitCode(exitCodes.usage);
      return;
    }

    throw error;
  }
}

async function runInitCommandOrThrow(
  options: InitCommandOptions,
  runtime: CliRuntime,
) {
  const watchedSavePath = path.resolve(requireOption(options.save, "--save"));
  const repoPath = path.resolve(requireOption(options.repo, "--repo"));

  await assertReadableSaveFile(watchedSavePath);
  await assertInitializableRepoDirectory(repoPath);

  const result = await initSaveHistory({
    repoPath,
    watchedSavePath,
  });

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  runtime.writeStdout(
    `initialized save history repository\nrepo: ${result.repoPath}\nconfig: ${result.configPath}\nnext: silksong-git history checkpoint --repo ${result.repoPath}\n`,
  );
}

async function runInspectCommand(
  options: InspectCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = path.resolve(requireOption(options.repo, "--repo"));
  const inspection = await inspectSaveHistoryRepository({ repoPath });
  const output = projectInspection(inspection);

  if (options.json === true) {
    runtime.writeStdout(formatJson(output));
  } else {
    runtime.writeStdout(formatInspection(output, repoPath));
  }

  if (inspection.status !== "ready") {
    runtime.setExitCode(exitCodes.readModelUnavailable);
  }
}

async function runMigrateCommand(
  options: MigrateCommandOptions,
  runtime: CliRuntime,
) {
  if (options.confirmMigration !== true) {
    runtime.writeStderr(
      "error: migration requires --confirm-migration\nnext: rerun with --confirm-migration to create a recoverable config backup before updating the repository format\n",
    );
    runtime.setExitCode(exitCodes.usage);
    return;
  }

  const repoPath = path.resolve(requireOption(options.repo, "--repo"));
  const inspection = await inspectSaveHistoryRepository({ repoPath });
  const result = await migrateSaveHistoryRepository({
    repoPath,
    inspectionId: inspection.inspectionId,
    confirmation: "migrate-save-history-repository",
  });
  const currentInspection =
    result.status === "migrated"
      ? result.inspection
      : await inspectSaveHistoryRepository({ repoPath });
  const output = projectMigrationResult(result, currentInspection);

  if (options.json === true) {
    runtime.writeStdout(formatJson(output));
  } else {
    runtime.writeStdout(formatMigrationResult(output, repoPath));
  }

  if (output.status === "failed" && output.reason === "repositoryBusy") {
    runtime.setExitCode(exitCodes.repositoryBusy);
    return;
  }

  if (output.status !== "migrated" && output.inspection.status !== "ready") {
    runtime.setExitCode(exitCodes.readModelUnavailable);
  }
}

function projectInspection(
  inspection: SaveHistoryRepositoryInspection,
): SafeRepositoryInspection {
  return {
    status: inspection.status,
    requiredAction: inspection.requiredAction,
    capabilities: inspection.capabilities,
  };
}

function projectMigrationResult(
  result: MigrateSaveHistoryRepositoryResult,
  currentInspection: SaveHistoryRepositoryInspection,
): SafeMigrationResult {
  return { ...result, inspection: projectInspection(currentInspection) };
}

function formatInspection(
  inspection: SafeRepositoryInspection,
  repoPath: string,
): string {
  return [
    "repository inspection",
    `status: ${inspection.status}`,
    `required action: ${inspection.requiredAction}`,
    `capabilities: ${formatCapabilities(inspection.capabilities)}`,
    `next: ${formatInspectionNext(inspection, repoPath)}`,
    "",
  ].join("\n");
}

function formatMigrationResult(
  result: SafeMigrationResult,
  repoPath: string,
): string {
  if (result.status === "migrated") {
    return [
      "repository migration complete",
      "backup: created",
      `status: ${result.inspection.status}`,
      `next: silksong-git repo inspect --repo ${repoPath}`,
      "",
    ].join("\n");
  }

  return [
    `repository migration ${result.status}`,
    `reason: ${result.reason}`,
    `status: ${result.inspection.status}`,
    `next: ${formatMigrationNext(result, repoPath)}`,
    "",
  ].join("\n");
}

function formatCapabilities(capabilities: readonly string[]): string {
  return capabilities.length === 0 ? "none" : capabilities.join(", ");
}

function formatInspectionNext(
  inspection: SafeRepositoryInspection,
  repoPath: string,
): string {
  switch (inspection.requiredAction) {
    case "open": {
      return "repository is ready";
    }

    case "rebuildReadModel": {
      return `silksong-git history rebuild --repo ${repoPath}`;
    }

    case "confirmMigration": {
      return `silksong-git repo migrate --repo ${repoPath} --confirm-migration`;
    }

    case "useNewerApp": {
      return "update Silksong Git";
    }

    case "chooseAnotherDirectory": {
      return "choose another repository";
    }
  }
}

function formatMigrationNext(
  result: Exclude<SafeMigrationResult, { readonly status: "migrated" }>,
  repoPath: string,
): string {
  if (
    result.reason === "staleInspection"
    && result.inspection.requiredAction === "confirmMigration"
  ) {
    return `silksong-git repo inspect --repo ${repoPath}`;
  }

  return formatInspectionNext(result.inspection, repoPath);
}

function requireOption(value: string | undefined, optionName: string): string {
  if (value === undefined || value === "") {
    throw new RepoInitUsageError(`error: ${optionName} is required`);
  }

  return value;
}

async function assertReadableSaveFile(savePath: string) {
  const saveStat = await readSaveFileStat(savePath);

  if (!saveStat.isFile()) {
    throw new RepoInitUsageError("error: save path must be a file");
  }
}

async function readSaveFileStat(savePath: string): Promise<Stats> {
  try {
    return await stat(savePath);
  } catch (error) {
    throw new RepoInitUsageError("error: save path must be readable", {
      cause: error,
    });
  }
}

async function assertInitializableRepoDirectory(repoPath: string) {
  const repoStat = await readExistingRepoPathStat(repoPath);

  if (repoStat === undefined) {
    return;
  }

  if (!repoStat.isDirectory()) {
    throw new RepoInitUsageError("error: repository path must be a directory");
  }

  const entries = await readdir(repoPath);
  if (entries.length > 0) {
    throw new RepoInitUsageError("error: repository path must be empty");
  }
}

async function readExistingRepoPathStat(
  repoPath: string,
): Promise<Stats | undefined> {
  try {
    return await stat(repoPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

class RepoInitUsageError extends Error {
  override name = "RepoInitUsageError";
}
