import { createDesktopRuntimeCapabilities } from "../runtime-capabilities/desktop.ts";

/** In-memory Desktop boundary used by Web behavior tests. */
export const desktopTestRuntimeCapabilities = createDesktopRuntimeCapabilities({
  getRepoSessionConnection: () => ({
    endpoint: "http://127.0.0.1:4312",
    token: "session-token",
  }),
  openExternalRepository: async () => await Promise.resolve({ kind: "opened" }),
  startWatching: async () => {
    await Promise.resolve();
  },
  stopWatching: async () => {
    await Promise.resolve();
  },
});
