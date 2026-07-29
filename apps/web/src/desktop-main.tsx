import { render } from "solid-js/web";

import { App } from "./app/App.tsx";
import { browserRuntimeCapabilities } from "./runtime-capabilities/browser.ts";
// Vite applies the root stylesheet through this import side effect.
// eslint-disable-next-line import-x/no-unassigned-import
import "./app/global.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Failed to find Solid root element for Desktop.");
}

// Desktop initially uses Static Save capabilities. A later Repo Session slice can replace this
// composition root.
render(() => <App runtimeCapabilities={browserRuntimeCapabilities} />, root);
