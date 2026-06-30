import type { DecodedSaveVersion } from "@silksong-git/core";
import {
  DecodeEncodedSaveError,
  decodeEncodedSave,
  parseDecodedSave,
} from "@silksong-git/core";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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

type ObservationMetadata = Omit<RawSaveObservation, "commit">;

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

export async function observeSave(
  input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  const config = await readProjectConfig(input.repoPath);
  const observedAt = input.observedAt ?? new Date();
  const encodedBytes = await readFile(config.watchedSavePath);
  const encodedSha256 = sha256Hex(encodedBytes);
  const lastObservation = await readLastObservation(input.repoPath);

  if (
    input.force !== true
    && lastObservation?.encodedSha256 === encodedSha256
  ) {
    return {
      status: "skipped",
      reason: "unchanged",
      encodedSha256,
    };
  }

  let decoded: ReturnType<typeof decodeEncodedSave>;
  try {
    decoded = decodeEncodedSave(encodedBytes);
  } catch (error) {
    if (error instanceof DecodeEncodedSaveError) {
      return {
        status: "watcherError",
        error: {
          message: error.message,
          reason: "decodeFailure",
        },
      };
    }

    throw error;
  }

  const parsed = parseDecodedSave(decoded.decodedSave);
  const decodedJson = `${JSON.stringify(decoded.decodedSave, undefined, 2)}\n`;
  const previousCommit = await readCurrentHead(input.repoPath);
  const observationMetadata: ObservationMetadata = {
    observedAt: observedAt.toISOString(),
    sourcePath: config.watchedSavePath,
    encodedSha256,
    decodedSha256: sha256Hex(decodedJson),
    previousCommit,
    decoderVersion: decoded.version.decoderVersion,
    schema: {
      status: "recognized",
      ...parsed.version,
    },
  };

  await copyFile(config.watchedSavePath, path.join(input.repoPath, "save.dat"));
  await writeFile(path.join(input.repoPath, "decoded-save.json"), decodedJson);
  await writeFile(
    path.join(input.repoPath, "observation.json"),
    `${JSON.stringify(observationMetadata, undefined, 2)}\n`,
  );
  await runGit(input.repoPath, [
    "add",
    ".gitignore",
    ".silksong-git/config.json",
    "save.dat",
    "decoded-save.json",
    "observation.json",
  ]);
  await runGit(
    input.repoPath,
    [
      "-c",
      "user.name=silksong-git",
      "-c",
      "user.email=silksong-git@example.invalid",
      "commit",
      "-m",
      `Observe save ${observationMetadata.observedAt}`,
    ],
    {
      GIT_AUTHOR_DATE: observationMetadata.observedAt,
      GIT_COMMITTER_DATE: observationMetadata.observedAt,
    },
  );

  return {
    status: "committed",
    observation: {
      commit: await readHistoryCommit(input.repoPath, "HEAD"),
      ...observationMetadata,
    },
    semanticUpdate: {
      status: "notAvailable",
      reason: "readModelUnavailable",
    },
  };
}

export async function restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult> {
  if (input.target.kind !== "path") {
    throw new Error("In-place restore is not implemented yet.");
  }

  const encodedSave = await readGitBlob(
    input.repoPath,
    input.commitRef,
    "save.dat",
  );

  await writeFile(input.target.path, encodedSave);

  return {
    commit: await readHistoryCommit(input.repoPath, input.commitRef),
    targetPath: input.target.path,
    writtenSha256: sha256Hex(encodedSave),
  };
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

async function readProjectConfig(repoPath: string): Promise<ProjectConfig> {
  const configJson = await readFile(
    path.join(repoPath, ".silksong-git/config.json"),
    "utf8",
  );

  return JSON.parse(configJson) as ProjectConfig;
}

async function readLastObservation(
  repoPath: string,
): Promise<ObservationMetadata | undefined> {
  try {
    const observationJson = await readFile(
      path.join(repoPath, "observation.json"),
      "utf8",
    );

    return JSON.parse(observationJson) as ObservationMetadata;
  } catch {
    return undefined;
  }
}

async function readCurrentHead(repoPath: string): Promise<string | undefined> {
  try {
    return await runGitOutput(repoPath, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return undefined;
  }
}

async function readHistoryCommit(
  repoPath: string,
  ref: string,
): Promise<HistoryCommit> {
  const [fullRef, shortRef, committedAt] = await Promise.all([
    runGitOutput(repoPath, ["rev-parse", ref]),
    runGitOutput(repoPath, ["rev-parse", "--short", ref]),
    runGitOutput(repoPath, ["show", "-s", "--format=%cI", ref]),
  ]);

  return {
    ref: fullRef,
    shortRef,
    committedAt,
  };
}

async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: { ...process.env, ...env } },
      (error) => {
        if (error) {
          reject(
            error instanceof Error ? error : new Error("Git command failed."),
          );
          return;
        }

        resolve();
      },
    );
  });
}

async function runGitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const output = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error, stdout) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error("Git command failed."),
        );
        return;
      }

      resolve({ stdout });
    });
  });

  return output.stdout.trim();
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function readGitBlob(
  repoPath: string,
  commitRef: string,
  artifactPath: string,
): Promise<Buffer> {
  const output = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
    execFile(
      "git",
      ["show", `${commitRef}:${artifactPath}`],
      {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        cwd: repoPath,
      },
      (error, stdout) => {
        if (error) {
          reject(
            error instanceof Error ? error : new Error("Git command failed."),
          );
          return;
        }

        resolve({ stdout });
      },
    );
  });

  return output.stdout;
}
