import type { SearchSemanticEventsInput } from "@silksong-git/history";
import {
  diffCommits,
  observeSave,
  queryHistory,
  rebuildSemanticReadModel,
  searchSemanticEvents,
} from "@silksong-git/history";
import type { Command } from "commander";

import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";
import {
  RepositoryContextError,
  resolveRepositoryContext,
} from "./repo-context.ts";

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

export function registerHistoryCommands(program: Command): void {
  const historyCommand = program.command("history");

  historyCommand
    .command("list")
    .option("--repo <history-repo>")
    .option("--limit <n>")
    .option("--cursor <cursor>")
    .option("--include-filtered")
    .option("--json")
    .action(async (options: ListCommandOptions) => {
      await runListCommand(options);
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
        await runDiffCommand(fromRef, toRef, options);
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
      await runSearchCommand(options);
    });

  historyCommand
    .command("checkpoint")
    .option("--repo <history-repo>")
    .option("--message <text>")
    .option("--allow-unchanged")
    .option("--json")
    .action(async (options: CheckpointCommandOptions) => {
      await runCheckpointCommand(options);
    });

  historyCommand
    .command("rebuild")
    .option("--repo <history-repo>")
    .option("--json")
    .action(async (options: RebuildCommandOptions) => {
      await runRebuildCommand(options);
    });
}

async function runCheckpointCommand(options: CheckpointCommandOptions) {
  try {
    await runCheckpointCommandOrThrow(options);
  } catch (error) {
    if (handleHistoryCommandError(error)) {
      return;
    }

    throw error;
  }
}

async function runListCommand(options: ListCommandOptions) {
  try {
    await runListCommandOrThrow(options);
  } catch (error) {
    if (handleHistoryCommandError(error)) {
      return;
    }

    throw error;
  }
}

async function runSearchCommand(options: SearchCommandOptions) {
  try {
    await runSearchCommandOrThrow(options);
  } catch (error) {
    if (handleHistoryCommandError(error)) {
      return;
    }

    throw error;
  }
}

async function runDiffCommand(
  fromRef: string,
  toRef: string,
  options: DiffCommandOptions,
) {
  try {
    await runDiffCommandOrThrow(fromRef, toRef, options);
  } catch (error) {
    if (handleHistoryCommandError(error)) {
      return;
    }

    throw error;
  }
}

async function runListCommandOrThrow(options: ListCommandOptions) {
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
    process.stdout.write(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    process.stdout.write("no semantic events\n");
    return;
  }

  process.stdout.write(
    result.events
      .map((event) => `${event.commit.shortRef} ${event.event.eventType}`)
      .join("\n")
      .concat("\n"),
  );
}

async function runCheckpointCommandOrThrow(options: CheckpointCommandOptions) {
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
    process.stderr.write("cannot decode save\n");
    process.exitCode = exitCodes.decodeFailure;
    return;
  }

  if (options.json === true) {
    process.stdout.write(formatJson(result));
    return;
  }

  if (result.status === "committed") {
    process.stdout.write(
      `checkpoint recorded\ncommit: ${result.observation.commit.shortRef}\n`,
    );
    return;
  }

  if (result.reason === "unchanged") {
    process.stdout.write(
      "checkpoint skipped: unchanged\nnext: rerun with --allow-unchanged to record identical bytes\n",
    );
    return;
  }

  process.stdout.write(`checkpoint skipped: ${result.reason}\n`);
}

async function runSearchCommandOrThrow(options: SearchCommandOptions) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await searchSemanticEvents({
    repoPath,
    query: createSearchQuery(options),
    includeFiltered: options.includeFiltered,
  });

  if (options.json === true) {
    process.stdout.write(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    process.stdout.write("no matching semantic events\n");
    return;
  }

  process.stdout.write(
    result.events
      .map((event) => `${event.commit.shortRef} ${event.event.eventType}`)
      .join("\n")
      .concat("\n"),
  );
}

async function runDiffCommandOrThrow(
  fromRef: string,
  toRef: string,
  options: DiffCommandOptions,
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
    process.stdout.write(formatJson(result));
    return;
  }

  if (result.events.length === 0) {
    process.stdout.write("no semantic changes\n");
    return;
  }

  process.stdout.write(
    result.events
      .map((event) => `${event.commit.shortRef} ${event.event.eventType}`)
      .join("\n")
      .concat("\n"),
  );
}

async function runRebuildCommand(options: RebuildCommandOptions) {
  try {
    await runRebuildCommandOrThrow(options);
  } catch (error) {
    if (handleHistoryCommandError(error)) {
      return;
    }

    throw error;
  }
}

async function runRebuildCommandOrThrow(options: RebuildCommandOptions) {
  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const result = await rebuildSemanticReadModel({ repoPath });

  if (options.json === true) {
    process.stdout.write(formatJson(result));
    return;
  }

  process.stdout.write(
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

function handleHistoryCommandError(error: unknown): boolean {
  if (error instanceof RepositoryContextError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCodes.usage;
    return true;
  }

  if (error instanceof HistoryCommandUsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = exitCodes.usage;
    return true;
  }

  if (isReadModelUnavailableError(error)) {
    process.stderr.write(
      "semantic read model unavailable\nnext: silksong-git history rebuild\n",
    );
    process.exitCode = exitCodes.readModelUnavailable;
    return true;
  }

  if (isInvalidCommitRefError(error)) {
    process.stderr.write("error: invalid commit ref\n");
    process.exitCode = exitCodes.usage;
    return true;
  }

  if (isRepositoryBusyError(error)) {
    process.stderr.write("error: save history repository is busy\n");
    process.exitCode = exitCodes.repositoryBusy;
    return true;
  }

  return false;
}

function isReadModelUnavailableError(error: unknown): boolean {
  return String(error).includes("no such table");
}

function isInvalidCommitRefError(error: unknown): boolean {
  const message = String(error);

  return (
    message.includes("unknown revision or path not in the working tree")
    || message.includes("bad revision")
    || message.includes("ambiguous argument")
    || message.includes("Needed a single revision")
  );
}

function isRepositoryBusyError(error: unknown): boolean {
  return String(error).includes("Save History Repository is busy.");
}
