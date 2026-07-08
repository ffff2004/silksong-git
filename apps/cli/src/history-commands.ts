import type { SearchSemanticEventsInput } from "@silksong-git/history";
import {
  diffCommits,
  InvalidCommitRefError,
  InvalidRestoreBackupDirectoryError,
  observeSave,
  queryHistory,
  ReadModelUnavailableError,
  rebuildSemanticReadModel,
  RestoreBackupFailedError,
  restoreEncodedSave,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
  searchSemanticEvents,
} from "@silksong-git/history";
import type { Command } from "commander";
import path from "node:path";

import type { CliRuntime } from "./cli-runtime.ts";
import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";
import {
  RepositoryContextError,
  resolveRepositoryContext,
} from "./repo-context.ts";
import {
  formatHistoricalSemanticEventLine,
  formatSemanticUpdate,
} from "./semantic-event-output.ts";

interface CheckpointCommandOptions {
  readonly repo?: string;
  readonly message?: string;
  readonly allowUnchanged?: boolean;
  readonly json?: boolean;
}

interface RebuildCommandOptions {
  readonly repo?: string;
  readonly json?: boolean;
}

interface RestoreCommandOptions {
  readonly repo?: string;
  readonly to?: string;
  readonly inPlace?: boolean;
  readonly confirmInPlace?: boolean;
}

interface ListCommandOptions {
  readonly repo?: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly includeFiltered?: boolean;
  readonly json?: boolean;
}

interface SearchCommandOptions {
  readonly repo?: string;
  readonly event?: string;
  readonly itemId?: string;
  readonly label?: string;
  readonly type?: string;
  readonly statusTo?: string;
  readonly direction?: string;
  readonly includeFiltered?: boolean;
  readonly json?: boolean;
}

interface DiffCommandOptions {
  readonly repo?: string;
  readonly includeFiltered?: boolean;
  readonly json?: boolean;
}

export function registerHistoryCommands(
  program: Command,
  runtime: CliRuntime,
): void {
  const historyCommand = program.command("history");

  historyCommand
    .command("list")
    .option("--repo <history-repo>")
    .option("--limit <n>")
    .option("--cursor <cursor>")
    .option("--include-filtered")
    .option("--json")
    .action(async (options: ListCommandOptions) => {
      await runListCommand(options, runtime);
    });

  historyCommand
    .command("diff")
    .argument("<from>")
    .argument("<to>")
    .option("--repo <history-repo>")
    .option("--include-filtered")
    .option("--json")
    .action(
      async (fromRef: string, toRef: string, options: DiffCommandOptions) => {
        await runDiffCommand(fromRef, toRef, options, runtime);
      },
    );

  historyCommand
    .command("search")
    .option("--repo <history-repo>")
    .option("--event <text>")
    .option("--item-id <id>")
    .option("--label <text>")
    .option("--type <type>")
    .option("--status-to <status>")
    .option("--direction <direction>")
    .option("--include-filtered")
    .option("--json")
    .action(async (options: SearchCommandOptions) => {
      await runSearchCommand(options, runtime);
    });

  historyCommand
    .command("checkpoint")
    .option("--repo <history-repo>")
    .option("--message <text>")
    .option("--allow-unchanged")
    .option("--json")
    .action(async (options: CheckpointCommandOptions) => {
      await runCheckpointCommand(options, runtime);
    });

  historyCommand
    .command("restore")
    .argument("<commit>")
    .option("--to <path>")
    .option("--in-place")
    .option("--confirm-in-place")
    .option("--repo <history-repo>")
    .action(async (commitRef: string, options: RestoreCommandOptions) => {
      await runRestoreCommand(commitRef, options, runtime);
    });

  historyCommand
    .command("rebuild")
    .option("--repo <history-repo>")
    .option("--json")
    .action(async (options: RebuildCommandOptions) => {
      await runRebuildCommand(options, runtime);
    });
}

async function runCheckpointCommand(
  options: CheckpointCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runCheckpointCommandOrThrow(options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runListCommand(
  options: ListCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runListCommandOrThrow(options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runSearchCommand(
  options: SearchCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runSearchCommandOrThrow(options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runDiffCommand(
  fromRef: string,
  toRef: string,
  options: DiffCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runDiffCommandOrThrow(fromRef, toRef, options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runRestoreCommand(
  commitRef: string,
  options: RestoreCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runRestoreCommandOrThrow(commitRef, options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runListCommandOrThrow(
  options: ListCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await queryHistory({
    repoPath,
    includeFiltered: options.includeFiltered,
    limit:
      options.limit === undefined ? undefined : parseListLimit(options.limit),
    cursor: options.cursor,
  });

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    runtime.writeStdout("no semantic events\n");
    return;
  }

  runtime.writeStdout(
    result.events
      .map(formatHistoricalSemanticEventLine)
      .join("\n")
      .concat("\n"),
  );
}

async function runCheckpointCommandOrThrow(
  options: CheckpointCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await observeSave({
    repoPath,
    trigger: "manualCheckpoint",
    message: options.message,
    allowUnchanged: options.allowUnchanged,
  });

  if (result.status === "watcherError") {
    runtime.writeStderr("cannot decode save\n");
    runtime.setExitCode(exitCodes.decodeFailure);
    return;
  }

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  if (result.status === "committed") {
    runtime.writeStdout(
      `checkpoint recorded\ncommit: ${result.observation.commit.shortRef}\n${formatSemanticUpdate(result.semanticUpdate)}`,
    );
    return;
  }

  if (result.reason === "unchanged") {
    runtime.writeStdout(
      "checkpoint skipped: unchanged\nnext: rerun with --allow-unchanged to record identical bytes\n",
    );
    return;
  }

  runtime.writeStdout(`checkpoint skipped: ${result.reason}\n`);
}

async function runSearchCommandOrThrow(
  options: SearchCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await searchSemanticEvents({
    repoPath,
    query: createSearchQuery(options),
    includeFiltered: options.includeFiltered,
  });

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    runtime.writeStdout("no matching semantic events\n");
    return;
  }

  runtime.writeStdout(
    result.events
      .map(formatHistoricalSemanticEventLine)
      .join("\n")
      .concat("\n"),
  );
}

async function runDiffCommandOrThrow(
  fromRef: string,
  toRef: string,
  options: DiffCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await diffCommits({
    repoPath,
    fromRef,
    toRef,
    includeFiltered: options.includeFiltered,
  });

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    runtime.writeStdout("no semantic changes\n");
    return;
  }

  runtime.writeStdout(
    result.events
      .map(formatHistoricalSemanticEventLine)
      .join("\n")
      .concat("\n"),
  );
}

async function runRestoreCommandOrThrow(
  commitRef: string,
  options: RestoreCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const target = createRestoreTarget(options);
  const result = await restoreEncodedSave({
    repoPath,
    commitRef,
    target,
  });

  runtime.writeStdout(
    `restore complete\ncommit: ${result.commit.shortRef}\ntarget: ${result.targetPath}\nbackup: ${result.backupPath ?? "none"}\nsha256: ${result.writtenSha256}\n`,
  );
}

async function runRebuildCommand(
  options: RebuildCommandOptions,
  runtime: CliRuntime,
) {
  try {
    await runRebuildCommandOrThrow(options, runtime);
  } catch (error) {
    if (handleHistoryCommandError(error, runtime)) {
      return;
    }

    throw error;
  }
}

async function runRebuildCommandOrThrow(
  options: RebuildCommandOptions,
  runtime: CliRuntime,
) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await rebuildSemanticReadModel({ repoPath });

  if (options.json === true) {
    runtime.writeStdout(formatJson(result));
    return;
  }

  runtime.writeStdout(
    `read model rebuilt\nobservations: ${result.observationCount}\nevents: ${result.eventCount}\n`,
  );
}

function parseListLimit(value: string): number {
  if (!/^\d+$/v.test(value)) {
    throw new HistoryCommandUsageError(
      "error: limit must be an integer from 1 to 1000",
    );
  }

  const limit = Number(value);

  if (limit < 1 || limit > 1000) {
    throw new HistoryCommandUsageError(
      "error: limit must be an integer from 1 to 1000",
    );
  }

  return limit;
}

function createSearchQuery(
  options: SearchCommandOptions,
): SearchSemanticEventsInput["query"] {
  const query: SearchSemanticEventsInput["query"] = {
    ...(options.itemId !== undefined && { itemId: options.itemId }),
    ...(options.label !== undefined && { label: options.label }),
    ...(options.type !== undefined && { type: options.type }),
    ...(options.statusTo !== undefined && {
      statusTo: parseStatusTo(options.statusTo),
    }),
    ...(options.direction !== undefined && {
      direction: parseDirection(options.direction),
    }),
    ...(options.event !== undefined && { text: options.event }),
  };

  if (Object.keys(query).length === 0) {
    throw new HistoryCommandUsageError(
      "error: at least one query flag is required",
    );
  }

  return query;
}

function createRestoreTarget(
  options: RestoreCommandOptions,
): Parameters<typeof restoreEncodedSave>[0]["target"] {
  if (options.confirmInPlace === true && options.inPlace !== true) {
    throw new HistoryCommandUsageError(
      "error: --confirm-in-place requires --in-place",
    );
  }

  const hasPathTarget = options.to !== undefined;
  const hasInPlaceTarget = options.inPlace === true;

  if (hasPathTarget === hasInPlaceTarget) {
    throw new HistoryCommandUsageError(
      "error: restore target must be exactly one of --to or --in-place",
    );
  }

  if (hasInPlaceTarget) {
    if (options.confirmInPlace !== true) {
      throw new HistoryCommandUsageError(
        "error: in-place restore requires --confirm-in-place\nnext: rerun with --in-place --confirm-in-place to overwrite the watched save after creating a backup",
      );
    }

    return {
      kind: "inPlace",
      confirmation: "restore-watched-save",
    };
  }

  const targetPath = options.to;

  if (targetPath === undefined) {
    throw new HistoryCommandUsageError(
      "error: restore target must be exactly one of --to or --in-place",
    );
  }

  return {
    kind: "path",
    path: path.resolve(targetPath),
  };
}

function parseStatusTo(
  value: string,
): SearchSemanticEventsInput["query"]["statusTo"] {
  if (
    value === "accepted"
    || value === "done"
    || value === "missing"
    || value === "unknown"
  ) {
    return value;
  }

  throw new HistoryCommandUsageError(
    "error: status-to must be one of accepted, done, missing, unknown",
  );
}

function parseDirection(
  value: string,
): SearchSemanticEventsInput["query"]["direction"] {
  if (
    value === "neutral"
    || value === "progression"
    || value === "regression"
  ) {
    return value;
  }

  throw new HistoryCommandUsageError(
    "error: direction must be one of neutral, progression, regression",
  );
}

class HistoryCommandUsageError extends Error {
  override name = "HistoryCommandUsageError";
}

function handleHistoryCommandError(
  error: unknown,
  runtime: CliRuntime,
): boolean {
  if (error instanceof RepositoryContextError) {
    runtime.writeStderr(`${error.message}\n`);
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof HistoryCommandUsageError) {
    runtime.writeStderr(`${error.message}\n`);
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof ReadModelUnavailableError) {
    runtime.writeStderr(
      "semantic read model unavailable\nnext: silksong-git history rebuild\n",
    );
    runtime.setExitCode(exitCodes.readModelUnavailable);
    return true;
  }

  if (error instanceof InvalidCommitRefError) {
    runtime.writeStderr("error: invalid commit ref\n");
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof RestoreTargetExistsError) {
    runtime.writeStderr(
      "error: restore target already exists\nnext: choose a new --to path\n",
    );
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof InvalidRestoreBackupDirectoryError) {
    runtime.writeStderr("error: invalid restore backup directory\n");
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof RestoreBackupFailedError) {
    runtime.writeStderr("error: failed to create restore backup\n");
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof RestoreWriteFailedError) {
    runtime.writeStderr(formatRestoreWriteFailure(error));
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof RestoreWriteVerificationError) {
    runtime.writeStderr(formatRestoreVerificationFailure(error));
    runtime.setExitCode(exitCodes.usage);
    return true;
  }

  if (error instanceof SaveHistoryRepositoryBusyError) {
    runtime.writeStderr("error: save history repository is busy\n");
    runtime.setExitCode(exitCodes.repositoryBusy);
    return true;
  }

  return false;
}

function formatRestoreWriteFailure(error: RestoreWriteFailedError): string {
  return `error: failed to write restore target${formatBackupHint(error.backupPath)}`;
}

function formatRestoreVerificationFailure(
  error: RestoreWriteVerificationError,
): string {
  return `error: restore write verification failed${formatBackupHint(error.backupPath)}`;
}

function formatBackupHint(backupPath: string | undefined): string {
  if (backupPath === undefined) {
    return "\n";
  }

  return `\nbackup: ${backupPath}\n`;
}
