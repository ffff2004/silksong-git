import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { initSaveHistory } from "@silksong-git/history";
import type { Command } from "commander";

import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";

interface InitCommandOptions {
  readonly save?: string;
  readonly repo?: string;
  readonly json?: boolean;
}

export function registerRepoCommands(program: Command): void {
  const repoCommand = program.command("repo");

  repoCommand
    .command("init")
    .requiredOption("--save <save.dat>")
    .requiredOption("--repo <history-repo>")
    .option("--json")
    .action(async (options: InitCommandOptions) => {
      await runInitCommand(options);
    });
}

async function runInitCommand(options: InitCommandOptions) {
  try {
    await runInitCommandOrThrow(options);
  } catch (error) {
    if (error instanceof RepoInitUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = exitCodes.usage;
      return;
    }

    throw error;
  }
}

async function runInitCommandOrThrow(options: InitCommandOptions) {
  const watchedSavePath = path.resolve(requireOption(options.save, "--save"));
  const repoPath = path.resolve(requireOption(options.repo, "--repo"));

  await assertReadableSaveFile(watchedSavePath);
  await assertInitializableRepoDirectory(repoPath);

  const result = await initSaveHistory({
    repoPath,
    watchedSavePath,
  });

  if (options.json === true) {
    process.stdout.write(formatJson(result));
    return;
  }

  process.stdout.write(
    `initialized save history repository\nrepo: ${result.repoPath}\nconfig: ${result.configPath}\nnext: silksong-git history checkpoint --repo ${result.repoPath}\n`,
  );
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
