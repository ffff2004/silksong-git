import type {
  SemanticEvent,
  SemanticItemEvent,
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import type { JSX } from "solid-js";
import { createContext, createMemo, useContext } from "solid-js";

import type { SaveMode } from "../current-save/load-current-save.ts";

interface ProgressSnapshotStore {
  readonly hasSave: () => boolean;
  readonly isChanged: (itemId: string) => boolean;
  readonly mode: () => SaveMode;
  readonly semanticItem: (itemId: string) => SemanticSnapshotItem | undefined;
  readonly shouldShowItem: (itemId: string) => boolean;
}

export type ProgressSnapshotPresentation =
  | { readonly kind: "current" }
  | {
      readonly before: SemanticSnapshot;
      readonly events: readonly SemanticEvent[];
      readonly kind: "comparison";
    };

const ProgressSnapshotContext = createContext<ProgressSnapshotStore>();

export function ProgressSnapshotProvider(props: {
  readonly children: JSX.Element;
  readonly presentation?: ProgressSnapshotPresentation;
  readonly snapshot: SemanticSnapshot | undefined;
  readonly showUnchanged?: () => boolean;
}) {
  const presentation = props.presentation ?? { kind: "current" as const };
  const showUnchanged = props.showUnchanged ?? (() => true);
  const semanticItemsById = createMemo(
    () => new Map(props.snapshot?.items.map((item) => [item.id, item])),
  );
  const changedItemsById = createMemo(() => {
    if (presentation.kind !== "comparison") {
      return new Map<string, SemanticItemEvent>();
    }

    return new Map(
      presentation.events.flatMap((event) =>
        event.kind === "item" ? [[event.item.id, event]] : [],
      ),
    );
  });
  const store: ProgressSnapshotStore = {
    hasSave: () => props.snapshot !== undefined,
    isChanged: (itemId) => changedItemsById().has(itemId),
    mode: () =>
      isSteelSoulMode(props.snapshot?.summary.permadeathMode)
        ? "steel"
        : "normal",
    semanticItem: (itemId) => semanticItemsById().get(itemId),
    shouldShowItem: (itemId) =>
      presentation.kind !== "comparison"
      || showUnchanged()
      || changedItemsById().has(itemId),
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
