import { describe, expect, it } from "vitest";

import { selectCompositionRoot } from "./vite-entry.ts";

const TEMPLATE = [
  '<meta content="__SILKSONG_GIT_COMPOSITION__">',
  '<script src="__SILKSONG_GIT_APP_ENTRY__"></script>',
].join("");

describe("selectCompositionRoot", () => {
  it("selects the explicitly named Browser entry", () => {
    expect(selectCompositionRoot(TEMPLATE, "browser")).toContain(
      'content="browser"><script src="/src/main.tsx"',
    );
  });

  it("selects the explicitly named Desktop entry", () => {
    expect(selectCompositionRoot(TEMPLATE, "desktop")).toContain(
      'content="desktop"><script src="/src/desktop-main.tsx"',
    );
  });

  it.each([
    ["missing", TEMPLATE.replace("__SILKSONG_GIT_APP_ENTRY__", "")],
    ["duplicate", `${TEMPLATE}__SILKSONG_GIT_APP_ENTRY__`],
  ])("rejects a %s entry placeholder", (_case, html) => {
    expect(() => selectCompositionRoot(html, "desktop")).toThrow(
      "Expected exactly one __SILKSONG_GIT_APP_ENTRY__ placeholder.",
    );
  });
});
