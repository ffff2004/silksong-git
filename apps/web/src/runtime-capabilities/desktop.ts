import type {
  OpenExternalRepositoryResult,
  PickStaticEncodedSaveResult,
  RepoSessionConnection,
  RepositoryLibrary,
  RepositoryLifecycle,
  RuntimeCapabilities,
} from "./interface.ts";

export function createDesktopRuntimeCapabilities(input: {
  readonly getRepoSessionConnection: () =>
    | Promise<RepoSessionConnection>
    | RepoSessionConnection;
  readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
  readonly pickStaticEncodedSave?: () => Promise<PickStaticEncodedSaveResult>;
  readonly onStaticEncodedSavePicked?: (
    listener: (result: PickStaticEncodedSaveResult) => void,
  ) => Promise<() => void>;
  readonly closeRepository?: () => Promise<void>;
  readonly getRepositoryLibrary?: () => Promise<RepositoryLibrary>;
  readonly openLibraryEntry?: (input: {
    readonly lifecycle: Exclude<RepositoryLifecycle, "external">;
    readonly name: string;
  }) => Promise<OpenExternalRepositoryResult>;
  readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
  readonly startWatching: () => Promise<void>;
  readonly stopWatching: () => Promise<void>;
}): RuntimeCapabilities {
  return {
    getRepoSessionConnection: input.getRepoSessionConnection,
    closeRepository: input.closeRepository,
    getRepositoryLibrary: input.getRepositoryLibrary,
    kind: "desktop",
    openExternalRepository: input.openExternalRepository,
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
