import type { DecodedSaveVersion } from "@silksong-git/core";

export type ProjectConfigOverrides = Record<string, unknown>;

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
  _input: InitSaveHistoryInput,
): Promise<InitSaveHistoryResult> {
  await Promise.resolve();
  throw new Error("initSaveHistory is not implemented yet.");
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
