import type {
  DecodedSaveVersion,
  SaveSummaryMetrics,
  SemanticEvent,
  SemanticEventDirection,
  SemanticSnapshot,
  SemanticSnapshotItemStatus,
} from "@silksong-git/core";

export interface ProjectConfig {
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
}

export interface ProjectConfigOverrides {
  readonly capturePolicy?: Partial<ProjectConfig["capturePolicy"]>;
  readonly displaySemanticEventFilters?: Partial<
    ProjectConfig["displaySemanticEventFilters"]
  >;
  readonly restore?: ProjectConfig["restore"];
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
  readonly trigger?: ObservationTrigger;
  readonly message?: string;
  readonly allowUnchanged?: boolean;
}

export interface AcquireSaveHistoryWatcherInput {
  readonly repoPath: string;
  readonly startedAt?: Date;
}

export interface SaveHistoryWatcher {
  readonly watchedSavePath: string;
  readonly capturePolicy: ProjectConfig["capturePolicy"];
  observe: (
    input: ObserveSaveHistoryWatcherInput,
  ) => Promise<ObserveSaveResult>;
  release: () => Promise<void>;
}

export interface ObserveSaveHistoryWatcherInput {
  readonly observedAt: Date;
}

export type ObservationTrigger = "watcher" | "manualCheckpoint";

export type ObserveSaveResult =
  | {
      readonly status: "committed";
      readonly observation: RawSaveObservation;
      readonly semanticUpdate: SemanticUpdateResult;
    }
  | {
      readonly status: "skipped";
      readonly reason: "unchanged";
      readonly encodedSha256: string;
    }
  | {
      readonly status: "skipped";
      readonly reason: "minimumCommitInterval";
      readonly encodedSha256: string;
      readonly nextAllowedAt: string;
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
      readonly events: readonly HistoricalSemanticEvent[];
    }
  | {
      readonly status: "notAvailable";
      readonly reason: "unrecognizedSchema" | "readModelUnavailable";
    };

export interface HistoricalSemanticEvent {
  readonly id: string;
  readonly commit: HistoryCommit;
  readonly previousCommit?: HistoryCommit;
  readonly observation: RawSaveObservation;
  readonly snapshotSummary: SaveSummaryMetrics;
  readonly event: SemanticEvent;
  readonly visibility: {
    readonly defaultVisible: boolean;
    readonly filterReasons: readonly string[];
  };
}

export interface RebuildSemanticReadModelInput {
  readonly repoPath: string;
}

export interface RebuildSemanticReadModelResult {
  readonly observationCount: number;
  readonly recognizedObservationCount: number;
  readonly unrecognizedObservationCount: number;
  readonly snapshotCount: number;
  readonly eventCount: number;
}

export interface QueryHistoryInput {
  readonly repoPath: string;
  readonly includeFiltered?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: HistoryOrder;
}

export interface HistoryResult {
  readonly events: readonly HistoricalSemanticEvent[];
  readonly nextCursor?: string;
}

type HistoryOrder = "asc" | "desc";

export interface QueryRawObservationsInput {
  readonly repoPath: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: HistoryOrder;
}

export interface RawObservationHistoryResult {
  readonly entries: readonly RawObservationHistoryEntry[];
  readonly nextCursor?: string;
}

export interface RawObservationHistoryEntry {
  readonly observation: RawSaveObservation;
  readonly snapshotSummary: SaveSummaryMetrics | null;
}

type SaveStateSelector =
  | { readonly kind: "latest" }
  | { readonly kind: "commit"; readonly commitRef: string };

export interface GetSaveStateInput {
  readonly repoPath: string;
  readonly selector: SaveStateSelector;
}

export type GetSaveStateResult =
  | {
      readonly status: "available";
      readonly observation: RawSaveObservation;
      readonly decodedSave: unknown;
      readonly semanticSnapshot: SemanticSnapshot | null;
    }
  | { readonly status: "empty" };

export interface ReadEncodedSaveInput {
  readonly repoPath: string;
  readonly commitRef: string;
}

export interface ReadEncodedSaveResult {
  readonly commit: HistoryCommit;
  readonly encodedBytes: Uint8Array;
  readonly encodedSha256: string;
  readonly suggestedFileName: string;
}

export interface DiffCommitsInput {
  readonly repoPath: string;
  readonly fromRef: string;
  readonly toRef: string;
  readonly includeFiltered?: boolean;
}

export interface DiffCommitsResult {
  readonly from: HistoryCommit;
  readonly to: HistoryCommit;
  readonly before: SemanticSnapshot;
  readonly after: SemanticSnapshot;
  readonly events: readonly HistoricalSemanticEvent[];
}

export interface SearchSemanticEventsInput {
  readonly repoPath: string;
  readonly query: {
    readonly itemId?: string;
    readonly label?: string;
    readonly type?: string;
    readonly statusTo?: SemanticSnapshotItemStatus;
    readonly eventType?: string;
    readonly direction?: SemanticEventDirection;
    readonly text?: string;
  };
  readonly includeFiltered?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: HistoryOrder;
}

export interface SearchSemanticEventsResult {
  readonly events: readonly HistoricalSemanticEvent[];
  readonly nextCursor?: string;
}

export interface WatcherError {
  readonly message: string;
  readonly reason: "decodeFailure" | "readFailure" | "stabilityTimeout";
}

export interface HistoryCommit {
  readonly ref: string;
  readonly shortRef: string;
  readonly committedAt: string;
}

export interface RawSaveObservation {
  readonly commit: HistoryCommit;
  readonly observedAt: string;
  readonly trigger: ObservationTrigger;
  readonly message?: string;
  readonly sourcePath: string;
  readonly encodedSha256: string;
  readonly previousCommit?: string;
  readonly decodedSha256: string;
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
      readonly expectedCurrent?:
        | { readonly status: "present"; readonly encodedSha256: string }
        | { readonly status: "missing" };
    };

export interface RestoreEncodedSaveInput {
  readonly repoPath: string;
  readonly commitRef: string;
  readonly now?: Date;
  readonly target: RestoreTarget;
}

export interface RestoreEncodedSaveResult {
  readonly commit: HistoryCommit;
  readonly targetPath: string;
  readonly writtenSha256: string;
  readonly backupPath?: string;
}
