import type {
  DecodedSaveVersion,
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
  readonly localApi: {
    readonly host: "127.0.0.1";
  };
}

export interface ProjectConfigOverrides {
  readonly capturePolicy?: Partial<ProjectConfig["capturePolicy"]>;
  readonly displaySemanticEventFilters?: Partial<
    ProjectConfig["displaySemanticEventFilters"]
  >;
  readonly restore?: ProjectConfig["restore"];
  readonly localApi?: Partial<ProjectConfig["localApi"]>;
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
  readonly observations: readonly RawSaveObservation[];
  readonly nextCursor?: string;
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

export interface StartLocalHistoryWatchProcessInput {
  readonly repoPath: string;
  readonly http?: {
    readonly port?: number;
  };
  readonly watchEventSource?: WatchEventSource;
  readonly watchScheduler?: WatchScheduler;
  readonly fileStabilityProbe?: FileStabilityProbe;
  readonly onEvent?: (event: LocalHistoryWatchProcessEvent) => void;
  readonly now?: () => Date;
}

export interface LocalHistoryWatchProcess {
  readonly repoPath: string;
  readonly http?: {
    readonly endpoint: string;
    readonly token: string;
  };
  readonly getWatcherStatus: () => LocalHistoryWatcherStatus;
  stop: () => void | Promise<void>;
}

export interface LocalHistoryWatcherStatus {
  readonly status: "running";
  readonly activity: "idle" | "pending" | "observing";
  readonly observationRevision: number;
  readonly startedAt: string;
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly capturePolicy: ProjectConfig["capturePolicy"];
  readonly lastObservation?: LocalHistoryWatcherObservationSummary;
}

type LocalHistoryWatcherObservationSummary =
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "committed";
      readonly commit: HistoryCommit;
      readonly eventCount: number;
      readonly semanticStatus: "updated" | "notAvailable";
    }
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "skipped";
      readonly reason: "unchanged" | "minimumCommitInterval";
      readonly nextAllowedAt?: string;
    }
  | {
      readonly cause: "startup" | "change" | "deferred";
      readonly completedAt: string;
      readonly status: "watcherError";
      readonly error: WatcherError;
    };

export type LocalHistoryWatchProcessEvent =
  | {
      readonly type: "started";
      readonly repoPath: string;
      readonly watchedSavePath: string;
      readonly capturePolicy: ProjectConfig["capturePolicy"];
      readonly http?: {
        readonly endpoint: string;
        readonly token: string;
      };
    }
  | {
      readonly type: "httpRequestError";
      readonly repoPath: string;
      readonly error: {
        readonly method: string;
        readonly path: string;
        readonly status: number;
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly type: "observation";
      readonly repoPath: string;
      readonly cause: "startup" | "change" | "deferred";
      readonly result: ObserveSaveResult;
    }
  | {
      readonly type: "fatalError";
      readonly repoPath: string;
      readonly error: LocalHistoryWatchProcessFatalError;
    }
  | {
      readonly type: "stopping";
      readonly repoPath: string;
    }
  | {
      readonly type: "stopped";
      readonly repoPath: string;
    };

export interface LocalHistoryWatchProcessFatalError {
  readonly message: string;
  readonly reason: "httpServerFailure" | "watchBackendFailure";
}

export interface WatchEventSource {
  start: (
    input: WatchEventSourceStartInput,
  ) => WatchEventSubscription | Promise<WatchEventSubscription>;
}

export interface WatchEventSourceStartInput {
  readonly watchedSavePath: string;
  readonly onChange: () => void | Promise<void>;
  readonly onError: (error: unknown) => void | Promise<void>;
}

export interface WatchEventSubscription {
  stop: () => void | Promise<void>;
}

export interface WatchScheduler {
  scheduleAt: (
    runAt: Date,
    task: () => void | Promise<void>,
  ) => ScheduledWatchTask;
}

export interface ScheduledWatchTask {
  cancel: () => void;
}

export interface FileStabilityProbe {
  waitForStableFile: (filePath: string) => Promise<void>;
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
