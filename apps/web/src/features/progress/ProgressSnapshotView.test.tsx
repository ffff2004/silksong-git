import {
  createSemanticSnapshot,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { PreferencesProvider } from "../../state/preferences-store.tsx";
import decodedSave from "../../test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json";
import { ProgressSnapshotView } from "./ProgressSnapshotView.tsx";

describe("ProgressSnapshotView", () => {
  afterEach(() => {
    cleanup();
    globalThis.localStorage.clear();
  });

  it("renders progress directly from an explicit Semantic Snapshot", () => {
    const snapshot = createSemanticSnapshot(
      parseDecodedSave(decodedSave),
      getBuiltinMappingData(),
    );

    render(() => (
      <PreferencesProvider>
        <ProgressSnapshotView snapshot={snapshot} />
      </PreferencesProvider>
    ));

    expect(document.querySelector("#completionValue")?.textContent).toBe("39%");
    expect(document.querySelector("#rosariesValue")?.textContent).toBe("800");
    expect(
      screen.getByText("Mask Shard #2").closest(".boss")?.classList,
    ).toContain("done");
  });
});
