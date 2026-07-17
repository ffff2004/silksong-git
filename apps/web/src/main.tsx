import { render } from "solid-js/web";

import { App } from "./app/App.tsx";
// Vite applies the root stylesheet through this import side effect.
// eslint-disable-next-line import-x/no-unassigned-import
import "./app/global.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Failed to find Solid root element.");
}

render(() => <App />, root);
