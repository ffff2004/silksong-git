import type { RuntimeCapabilities } from "./interface.ts";

/** Production capabilities for the browser-only Static Web build. */
export const browserRuntimeCapabilities: RuntimeCapabilities = {
  kind: "browser",
};
