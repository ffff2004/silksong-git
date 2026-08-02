import type {
  OpenExternalRepositoryResult,
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
    openLibraryEntry: input.openLibraryEntry,
    reopenRepository: input.reopenRepository,
    startWatching: input.startWatching,
    stopWatching: input.stopWatching,
  };
}
