import type {
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import type { JSX } from "solid-js";
import { createContext, createMemo, useContext } from "solid-js";

import type { SaveMode } from "../current-save/load-current-save.ts";

interface ProgressSnapshotStore {
  readonly hasSave: () => boolean;
  readonly mode: () => SaveMode;
  readonly semanticItem: (itemId: string) => SemanticSnapshotItem | undefined;
}

const ProgressSnapshotContext = createContext<ProgressSnapshotStore>();

export function ProgressSnapshotProvider(props: {
  readonly children: JSX.Element;
  readonly snapshot: SemanticSnapshot | undefined;
}) {
  const semanticItemsById = createMemo(
    () => new Map(props.snapshot?.items.map((item) => [item.id, item])),
  );
  const store: ProgressSnapshotStore = {
    hasSave: () => props.snapshot !== undefined,
    mode: () =>
      isSteelSoulMode(props.snapshot?.summary.permadeathMode)
        ? "steel"
        : "normal",
    semanticItem: (itemId) => semanticItemsById().get(itemId),
  };

  return (
    <ProgressSnapshotContext.Provider value={store}>
      {props.children}
    </ProgressSnapshotContext.Provider>
  );
}

export function useProgressSnapshot(): ProgressSnapshotStore {
  const store = useContext(ProgressSnapshotContext);
  if (store === undefined) {
    throw new Error("Progress Snapshot is not available.");
  }

  return store;
}

function isSteelSoulMode(permadeathMode: unknown): boolean {
  return [1, 2, 3, "Dead", "On"].includes(permadeathMode as never);
}
