import { render } from "solid-js/web";

import { App } from "./app/App.tsx";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Failed to find Solid root element.");
}

render(() => <App />, root);
