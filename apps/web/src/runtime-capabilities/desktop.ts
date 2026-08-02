import type {
  OpenExternalRepositoryResult,
  RepoSessionConnection,
  RuntimeCapabilities,
} from "./interface.ts";

export function createDesktopRuntimeCapabilities(input: {
  readonly getRepoSessionConnection: () =>
    | Promise<RepoSessionConnection>
    | RepoSessionConnection;
  readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
  readonly reopenRepository?: () => Promise<OpenExternalRepositoryResult>;
  readonly startWatching: () => Promise<void>;
  readonly stopWatching: () => Promise<void>;
}): RuntimeCapabilities {
  return {
    getRepoSessionConnection: input.getRepoSessionConnection,
    kind: "desktop",
    openExternalRepository: input.openExternalRepository,
    reopenRepository: input.reopenRepository,
    startWatching: input.startWatching,
    stopWatching: input.stopWatching,
  };
}
