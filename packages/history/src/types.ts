import type {
  DecodedSaveVersion,
  SaveSummaryMetrics,
  SemanticEvent,
  SemanticEventDirection,
  SemanticSnapshot,
  SemanticSnapshotItemStatus,
} from "@silksong-git/core";

export interface ProjectConfig {
  readonly repositoryFormatVersion: number;
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

export type SaveHistoryRepositoryStatus =
  | "ready"
  | "rebuildRequired"
  | "legacyConfig"
  | "migrationRequired"
  | "newerIncompatible"
  | "invalid";

export type SaveHistoryRepositoryRequiredAction =
  | "open"
  | "rebuildReadModel"
  | "confirmMigration"
  | "useNewerApp"
  | "chooseAnotherDirectory";

export type SaveHistoryRepositoryCapability =
  | "read"
  | "observe"
  | "restore"
  | "rebuildReadModel"
  | "watch";

interface SaveHistoryRepositoryInspectionBase {
  readonly inspectionId: string;
  readonly status: SaveHistoryRepositoryStatus;
  readonly requiredAction: SaveHistoryRepositoryRequiredAction;
  readonly capabilities: readonly SaveHistoryRepositoryCapability[];
}

export type SaveHistoryRepositoryInspection =
  | (SaveHistoryRepositoryInspectionBase & {
      readonly status: "ready";
      readonly requiredAction: "open";
    })
  | (SaveHistoryRepositoryInspectionBase & {
      readonly status: "rebuildRequired";
      readonly requiredAction: "rebuildReadModel";
    })
  | (SaveHistoryRepositoryInspectionBase & {
      readonly status: "legacyConfig" | "migrationRequired";
      readonly requiredAction: "confirmMigration";
    })
  | (SaveHistoryRepositoryInspectionBase & {
      readonly status: "newerIncompatible";
      readonly requiredAction: "useNewerApp";
    })
  | (SaveHistoryRepositoryInspectionBase & {
      readonly status: "invalid";
      readonly requiredAction: "chooseAnotherDirectory";
    });

export interface InspectSaveHistoryRepositoryInput {
  readonly repoPath: string;
  /** Strict by default for CLI and ordinary repository workflows. */
  readonly gitIntegrityPolicy?: GitIntegrityPolicy;
}

export interface CompareWatchedSaveInput {
  readonly repoPath: string;
  readonly savePath: string;
}

export type GitIntegrityPolicy = "strict" | "advisory";

export interface MigrateSaveHistoryRepositoryInput {
  readonly repoPath: string;
  readonly inspectionId: string;
  readonly confirmation: string;
}

export interface PrepareSaveHistoryMigrationInput extends MigrateSaveHistoryRepositoryInput {
  /** An opaque, canonical destination selected by Desktop. */
  readonly snapshotPath: string;
}

export interface ArchiveSnapshot {
  readonly repoPath: string;
  readonly directoryDigest: string;
  readonly gitIntegrityWarning?: string;
}

export interface ArchiveManagedRepositoryInput {
  /**
   * Canonical App-owned roots; History validates placement but does not persist lifecycle state.
   */
  readonly managedRoot: string;
  readonly archivesRoot: string;
  readonly sourcePath: string;
  /** App-owned collision base name, without a path separator. */
  readonly archiveName: string;
}

export type ArchiveManagedRepositoryResult =
  | {
      readonly status: "archived";
      readonly repoPath: string;
      readonly name: string;
    }
  | {
      readonly status: "failed";
      readonly reason:
        | "invalidPlacement"
        | "repositoryBusy"
        | "watcherAlreadyAcquired"
        | "moveFailed";
      readonly message?: string;
    };

export type MigrationCleanupFailure = "leaseReleaseFailed";

export interface PreparedSaveHistoryMigration {
  readonly snapshot: ArchiveSnapshot;
  /**
   * Commits the already-published snapshot's migration. There is deliberately no user cancellation
   * or rollback path: the lease remains owned until this finishes.
   */
  readonly commit: () => Promise<MigrateSaveHistoryRepositoryResult>;
  /**
   * Releases the in-memory lease during Desktop sidecar process cleanup. This is a lifecycle
   * finalizer, not a user cancellation or retry operation.
   */
  readonly release: () => Promise<MigrationCleanupFailure | undefined>;
}

export type MigrationSourceState = "unchanged" | "migrated" | "unknown";

export type MigrationSnapshotState =
  | { readonly status: "notCreated" }
  | { readonly status: "retained"; readonly repoPath: string };

export type PrepareSaveHistoryMigrationResult =
  | {
      readonly status: "prepared";
      readonly operation: PreparedSaveHistoryMigration;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "confirmationRequired"
        | "staleInspection"
        | "migrationNotRequired";
    }
  | {
      readonly status: "failed";
      readonly reason:
        | "snapshotFailed"
        | "directoryDigestMismatch"
        | "repositoryBusy"
        | "watcherAlreadyAcquired";
      readonly message?: string;
    };

export type MigrateSaveHistoryRepositoryResult =
  | {
      readonly status: "migrated";
      readonly inspection: SaveHistoryRepositoryInspection;
      readonly backupCreated: true;
      readonly sourceState: "migrated";
      readonly snapshotState: MigrationSnapshotState;
      readonly cleanupFailure?: MigrationCleanupFailure;
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "confirmationRequired"
        | "staleInspection"
        | "migrationNotRequired";
      readonly sourceState: "unchanged";
      readonly snapshotState: MigrationSnapshotState;
      readonly cleanupFailure?: MigrationCleanupFailure;
    }
  | {
      readonly status: "failed";
      readonly reason: "backupFailed" | "repositoryBusy" | "migrationFailed";
      readonly sourceState: MigrationSourceState;
      readonly snapshotState: MigrationSnapshotState;
      readonly cleanupFailure?: MigrationCleanupFailure;
    };

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
  /** Allows a read-only session to browse compatible pre-migration archives. */
  readonly access?: "readOnly";
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
  /** Allows a read-only session to browse compatible pre-migration archives. */
  readonly access?: "readOnly";
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
  /** Allows a read-only session to browse compatible pre-migration archives. */
  readonly access?: "readOnly";
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
  /** Allows a read-only session to export from compatible pre-migration archives. */
  readonly access?: "readOnly";
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
  /** Allows a read-only session to browse compatible pre-migration archives. */
  readonly access?: "readOnly";
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
  /** Allows a read-only session to browse compatible pre-migration archives. */
  readonly access?: "readOnly";
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
