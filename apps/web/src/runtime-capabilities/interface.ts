export interface RepoSessionConnection {
  readonly endpoint: string;
  readonly token: string;
  readonly access?: "readWrite" | "readOnly";
}

export type RepositoryLifecycle = "managed" | "archived" | "external";

export type RepositoryOpenIntent = "open" | "rebuild";

export interface RepositoryLibraryEntry {
  readonly name: string;
  readonly lifecycle: RepositoryLifecycle;
  readonly status: string;
  readonly requiredAction: string;
  readonly current: boolean;
  readonly watching: boolean;
}

export interface RepositoryLibrary {
  readonly managed: readonly RepositoryLibraryEntry[];
  readonly archived: readonly RepositoryLibraryEntry[];
  readonly attention: readonly RepositoryLibraryEntry[];
  readonly external?: RepositoryLibraryEntry;
  readonly stale: boolean;
  readonly error?: string;
}

export interface RepositoryArchiveSnapshot {
  readonly repoPath: string;
  readonly directoryDigest: string;
  readonly gitIntegrityWarning?: string;
}

export type RepositoryMigrationPreparationResult =
  | { readonly kind: "prepared"; readonly snapshot: RepositoryArchiveSnapshot }
  | {
      readonly action:
        | "chooseAnotherDirectory"
        | "confirmMigration"
        | "rebuildReadModel"
        | "useNewerApp";
      readonly kind: "requiresAction";
      readonly status:
        | "invalid"
        | "legacyConfig"
        | "migrationRequired"
        | "newerIncompatible"
        | "rebuildRequired";
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly message?: string;
    }
  | { readonly kind: "blockedByMutation" }
  | { readonly kind: "busy" };

export type RepositoryMigrationCommitResult =
  | {
      readonly status: "migrated";
      readonly inspection: {
        readonly status: string;
        readonly requiredAction: string;
        readonly capabilities: readonly string[];
      };
      readonly backupCreated: true;
      readonly sourceState: "migrated";
      readonly snapshotState: RepositoryMigrationSnapshotState;
      readonly cleanupFailure?: "leaseReleaseFailed";
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
      readonly sourceState: "unchanged";
      readonly snapshotState: RepositoryMigrationSnapshotState;
      readonly cleanupFailure?: "leaseReleaseFailed";
    }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly sourceState: "unchanged" | "migrated" | "unknown";
      readonly snapshotState: RepositoryMigrationSnapshotState;
      readonly cleanupFailure?: "leaseReleaseFailed";
    };

export type RepositoryMigrationSnapshotState =
  | { readonly status: "notCreated" }
  | { readonly repoPath: string; readonly status: "retained" };

export type OpenExternalRepositoryResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "opened" }
  | { readonly kind: "busy" }
  | { readonly kind: "blockedByMutation" }
  | {
      readonly action:
        | "chooseAnotherDirectory"
        | "confirmMigration"
        | "rebuildReadModel"
        | "useNewerApp";
      readonly kind: "requiresAction";
      readonly status:
        | "invalid"
        | "legacyConfig"
        | "migrationRequired"
        | "newerIncompatible"
        | "rebuildRequired";
    };

export type PickStaticEncodedSaveResult =
  | { readonly kind: "cancelled" }
  | { readonly decodedSave: unknown; readonly kind: "loaded" }
  | { readonly kind: "invalidFile" }
  | { readonly kind: "decodeFailed" }
  /** Safe native picker or sidecar failure reported by the File menu event. */
  | { readonly kind: "failed"; readonly message: string };

export type ManagedInitializationResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "initialized" }
  | { readonly kind: "existingRepository"; readonly name: string }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly phase: string;
      readonly residualPath?: string;
    }
  | { readonly kind: "blockedByMutation" }
  | { readonly kind: "busy" };

export type ArchiveRepositoryResult =
  | { readonly kind: "archived"; readonly name: string }
  | { readonly kind: "busy" }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly message?: string;
    };

export type RuntimeCapabilities =
  | { readonly kind: "browser" }
  | {
      readonly getRepoSessionConnection: () =>
        | Promise<RepoSessionConnection>
        | RepoSessionConnection;
      readonly kind: "desktop";
      readonly closeRepository?: () => Promise<void>;
      readonly getRepositoryLibrary?: () => Promise<RepositoryLibrary>;
      readonly archiveRepository?: (input: {
        readonly lifecycle: "managed";
        readonly name: string;
      }) => Promise<ArchiveRepositoryResult>;
      readonly prepareRepositoryMigration?: (input: {
        readonly lifecycle: "managed";
        readonly name: string;
      }) => Promise<RepositoryMigrationPreparationResult>;
      readonly commitRepositoryMigration?: () => Promise<RepositoryMigrationCommitResult>;
      readonly openLibraryEntry?: (input: {
        readonly lifecycle: Exclude<RepositoryLifecycle, "external">;
        readonly name: string;
        readonly intent: RepositoryOpenIntent;
      }) => Promise<OpenExternalRepositoryResult>;
      readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
      readonly initializeManagedRepository?: () => Promise<ManagedInitializationResult>;
      /** Opens the native Encoded Save picker without exposing filesystem authority. */
      readonly pickStaticEncodedSave: () => Promise<PickStaticEncodedSaveResult>;
      /** Receives the outcome of the native File menu's equivalent picker action. */
      readonly onStaticEncodedSavePicked?: (
        listener: (result: PickStaticEncodedSaveResult) => void,
      ) => Promise<() => void>;
      /** Reopens only an explicitly invalidated in-memory Desktop selection. */
      readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
      readonly startWatching: () => Promise<void>;
      readonly stopWatching: () => Promise<void>;
    };
