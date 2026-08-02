import { invoke } from "@tauri-apps/api/core";
import { render } from "solid-js/web";

import { App } from "./app/App.tsx";
import { createDesktopRuntimeCapabilities } from "./runtime-capabilities/desktop.ts";
import type {
  OpenExternalRepositoryResult,
  RepoSessionConnection,
  RepositoryLibrary,
} from "./runtime-capabilities/interface.ts";
// Vite applies the root stylesheet through this import side effect.
// eslint-disable-next-line import-x/no-unassigned-import
import "./app/global.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Failed to find Solid root element for Desktop.");
}

const desktopRuntimeCapabilities = createDesktopRuntimeCapabilities({
  getRepoSessionConnection: async () =>
    await invoke<RepoSessionConnection>("desktop_get_repo_session_connection"),
  openExternalRepository: async () =>
    await invoke<OpenExternalRepositoryResult>(
      "desktop_open_external_repository",
    ),
  closeRepository: async () => {
    await invoke("desktop_close_repository");
  },
  getRepositoryLibrary: async () =>
    await invoke<RepositoryLibrary>("desktop_get_repository_library"),
  openLibraryEntry: async (input) =>
    await invoke<OpenExternalRepositoryResult>("desktop_open_library_entry", {
      input,
    }),
  reopenRepository: async () =>
    await invoke<OpenExternalRepositoryResult>("desktop_reopen_repository"),
  startWatching: async () => {
    await invoke("desktop_start_watching");
  },
  stopWatching: async () => {
    await invoke("desktop_stop_watching");
  },
});

render(() => <App runtimeCapabilities={desktopRuntimeCapabilities} />, root);
