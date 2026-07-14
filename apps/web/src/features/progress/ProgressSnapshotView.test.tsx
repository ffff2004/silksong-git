import type { SemanticItemEvent } from "@silksong-git/core";
import {
  createSemanticSnapshot,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
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

  it("shows changed items by default and can reveal unchanged items", () => {
    const before = createSemanticSnapshot(
      parseDecodedSave(decodedSave),
      getBuiltinMappingData(),
    );
    const changedItem = before.items.find(
      (item) => item.label === "Mask Shard #2",
    );
    if (changedItem === undefined) {
      throw new Error("Expected Mask Shard #2 in the snapshot.");
    }

    const after = {
      ...before,
      items: before.items.map((item) =>
        item.id === changedItem.id
          ? { ...item, status: "missing" as const }
          : item,
      ),
    };
    const changedEvent: SemanticItemEvent = {
      kind: "item",
      eventType: "itemStatusChanged",
      item: {
        id: changedItem.id,
        label: changedItem.label,
        sectionId: changedItem.sectionId,
        type: changedItem.type,
      },
      before: { status: changedItem.status, value: changedItem.value },
      after: { status: "missing", value: changedItem.value },
      direction: "regression",
      isRegression: true,
      sourceReferences: changedItem.sourceReferences,
      version: { before: before.version, after: after.version },
    };

    render(() => (
      <PreferencesProvider>
        <ProgressSnapshotView
          snapshot={after}
          presentation={{
            before,
            events: [changedEvent],
            kind: "comparison",
          }}
        />
      </PreferencesProvider>
    ));

    expect(getProgressCard("Mask Shard #2")).toBeDefined();
    expect(getProgressCard("Shining Needle")).toBeUndefined();
    expect(getProgressCard("Mask Shard #2")?.dataset["diffChanged"]).toBe(
      "true",
    );

    const showUnchangedButton = getButtonByText("Show unchanged");
    if (showUnchangedButton === undefined) {
      throw new Error("Expected Show unchanged button.");
    }
    fireEvent.click(showUnchangedButton);

    expect(getProgressCard("Shining Needle")).toBeDefined();
    expect(getButtonByText("Hide unchanged")).toBeDefined();
  });
});

function getProgressCard(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".boss")].find(
    (card) => card.querySelector(".title")?.textContent === label,
  );
}

function getButtonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent.trim() === label,
  );
}
