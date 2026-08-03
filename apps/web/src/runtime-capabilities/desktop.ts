import type {
  ManagedInitializationResult,
  OpenExternalRepositoryResult,
  PickStaticEncodedSaveResult,
  RepoSessionConnection,
  RepositoryLibrary,
  RepositoryLifecycle,
  RepositoryMigrationCommitResult,
  RepositoryMigrationPreparationResult,
  RepositoryOpenIntent,
  RuntimeCapabilities,
} from "./interface.ts";

export function createDesktopRuntimeCapabilities(input: {
  readonly getRepoSessionConnection: () =>
    | Promise<RepoSessionConnection>
    | RepoSessionConnection;
  readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
  readonly initializeManagedRepository?: () => Promise<ManagedInitializationResult>;
  readonly pickStaticEncodedSave?: () => Promise<PickStaticEncodedSaveResult>;
  readonly onStaticEncodedSavePicked?: (
    listener: (result: PickStaticEncodedSaveResult) => void,
  ) => Promise<() => void>;
  readonly closeRepository?: () => Promise<void>;
  readonly getRepositoryLibrary?: () => Promise<RepositoryLibrary>;
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
  readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
  readonly startWatching: () => Promise<void>;
  readonly stopWatching: () => Promise<void>;
}): RuntimeCapabilities {
  return {
    getRepoSessionConnection: input.getRepoSessionConnection,
    closeRepository: input.closeRepository,
    getRepositoryLibrary: input.getRepositoryLibrary,
    prepareRepositoryMigration: input.prepareRepositoryMigration,
    commitRepositoryMigration: input.commitRepositoryMigration,
    kind: "desktop",
    openExternalRepository: input.openExternalRepository,
    initializeManagedRepository: input.initializeManagedRepository,
    pickStaticEncodedSave:
      input.pickStaticEncodedSave
      ?? (async () => await Promise.resolve({ kind: "cancelled" })),
    onStaticEncodedSavePicked: input.onStaticEncodedSavePicked,
    openLibraryEntry: input.openLibraryEntry,
    reopenRepository: input.reopenRepository,
    startWatching: input.startWatching,
    stopWatching: input.stopWatching,
  };
}
