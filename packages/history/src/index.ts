import type { DecodedSaveVersion } from "@silksong-git/core";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProjectConfigOverrides = Record<string, unknown>;

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

export interface InitSaveHistoryInput {
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly config?: ProjectConfigOverrides;
}

export interface InitSaveHistoryResult {
  readonly repoPath: string;
  readonly configPath: string;
}

export interface ObserveSaveInput {
  readonly repoPath: string;
  readonly observedAt?: Date;
  readonly force?: boolean;
}

export type ObserveSaveResult =
  | {
      readonly status: "committed";
      readonly observation: RawSaveObservation;
      readonly semanticUpdate: SemanticUpdateResult;
    }
  | {
      readonly status: "skipped";
      readonly reason: "unchanged" | "minimumCommitInterval";
      readonly encodedSha256: string;
    }
  | {
      readonly status: "watcherError";
      readonly error: WatcherError;
    };

export type SemanticUpdateResult =
  | {
      readonly status: "updated";
      readonly snapshotId: string;
      readonly eventCount: number;
    }
  | {
      readonly status: "notAvailable";
      readonly reason: "unrecognizedSchema" | "readModelUnavailable";
    };

export interface WatcherError {
  readonly message: string;
  readonly reason: "decodeFailure" | "readFailure";
}

export interface HistoryCommit {
  readonly ref: string;
  readonly shortRef: string;
  readonly committedAt: string;
}

export interface RawSaveObservation {
  readonly commit: HistoryCommit;
  readonly observedAt: string;
  readonly sourcePath: string;
  readonly encodedSha256: string;
  readonly decodedSha256: string;
  readonly previousCommit?: string;
  readonly decoderVersion: string;
  readonly schema:
    | ({
        readonly status: "recognized";
      } & DecodedSaveVersion)
    | {
        readonly status: "unrecognized";
        readonly reason: string;
      };
}

export type RestoreTarget =
  | {
      readonly kind: "path";
      readonly path: string;
      readonly overwrite?: boolean;
    }
  | {
      readonly kind: "inPlace";
      readonly confirmation: "restore-watched-save";
      readonly backupDirectory?: string;
    };

export interface RestoreEncodedSaveInput {
  readonly repoPath: string;
  readonly commitRef: string;
  readonly target: RestoreTarget;
}

export interface RestoreEncodedSaveResult {
  readonly commit: HistoryCommit;
  readonly targetPath: string;
  readonly writtenSha256: string;
  readonly backupPath?: string;
}

export async function initSaveHistory(
  input: InitSaveHistoryInput,
): Promise<InitSaveHistoryResult> {
  await mkdir(input.repoPath, { recursive: true });
  await runGit(input.repoPath, ["init"]);

  const silksongGitDirectory = path.join(input.repoPath, ".silksong-git");
  const configPath = path.join(silksongGitDirectory, "config.json");

  await mkdir(silksongGitDirectory, { recursive: true });
  await writeFile(
    path.join(input.repoPath, ".gitignore"),
    ".silksong-git/read-model.sqlite\n",
  );
  await writeFile(
    configPath,
    `${JSON.stringify(createProjectConfig(input), undefined, 2)}\n`,
  );

  return {
    repoPath: input.repoPath,
    configPath,
  };
}

async function runGit(cwd: string, args: readonly string[]) {
  await new Promise<void>((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error("Git command failed."),
        );
        return;
      }

      resolve();
    });
  });
}

export async function observeSave(
  _input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  await Promise.resolve();
  throw new Error("observeSave is not implemented yet.");
}

export async function restoreEncodedSave(
  _input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult> {
  await Promise.resolve();
  throw new Error("restoreEncodedSave is not implemented yet.");
}

function createProjectConfig(input: InitSaveHistoryInput): ProjectConfig {
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
