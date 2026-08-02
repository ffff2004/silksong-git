import { createDesktopRuntimeCapabilities } from "../runtime-capabilities/desktop.ts";

export const desktopTestRepositoryLibrary = {
  archived: [],
  attention: [],
  managed: [
    {
      current: false,
      lifecycle: "managed" as const,
      name: "test-repository",
      requiredAction: "open",
      status: "ready",
      watching: false,
    },
  ],
  stale: false,
};

/** In-memory Desktop boundary used by Web behavior tests. */
export const desktopTestRuntimeCapabilities = createDesktopRuntimeCapabilities({
  getRepoSessionConnection: () => ({
    endpoint: "http://127.0.0.1:4312",
    token: "session-token",
    access: "readWrite",
  }),
  openExternalRepository: async () => await Promise.resolve({ kind: "opened" }),
  closeRepository: async () => {
    await Promise.resolve();
  },
  getRepositoryLibrary: async () =>
    await Promise.resolve(desktopTestRepositoryLibrary),
  openLibraryEntry: async () => await Promise.resolve({ kind: "opened" }),
  startWatching: async () => {
    await Promise.resolve();
  },
  stopWatching: async () => {
    await Promise.resolve();
  },
});
