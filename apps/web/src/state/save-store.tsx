import type {
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import type { LocalHttpSaveState } from "@silksong-git/repo-session/http-wire";
import type { JSX } from "solid-js";
import { createContext, createMemo, createSignal, useContext } from "solid-js";

import type { SaveMode } from "../features/current-save/load-current-save.ts";
import {
  loadCurrentSave,
  loadDecodedSave,
} from "../features/current-save/load-current-save.ts";

interface SaveStore {
  readonly decodedSave: () => unknown;
  readonly hasSave: () => boolean;
  readonly isLoading: () => boolean;
  readonly loadFile: (file: File | undefined) => Promise<LoadFileResult>;
  readonly loadLocalState: (
    state: LocalHttpSaveState,
    source?: Extract<DisplayedSaveSource, { readonly kind: "localCommit" }>,
  ) => void;
  readonly loadDecodedSave: (decodedSave: unknown) => LoadFileResult;
  readonly mode: () => SaveMode;
  readonly semanticItem: (itemId: string) => SemanticSnapshotItem | undefined;
  readonly snapshot: () => SemanticSnapshot | undefined;
  readonly source: () => DisplayedSaveSource;
  readonly clear: () => void;
}

export type DisplayedSaveSource =
  | { readonly kind: "empty" }
  | { readonly kind: "static" }
  | { readonly kind: "localLatest" }
  | { readonly commit: string; readonly kind: "localCommit" };

type LoadFileResult =
  | { readonly ok: true }
  | { readonly message: string; readonly ok: false };

const SaveContext = createContext<SaveStore>();

export function SaveProvider(props: { readonly children: JSX.Element }) {
  const [decodedSave, setDecodedSave] = createSignal<unknown>();
  const [snapshot, setSnapshot] = createSignal<SemanticSnapshot>();
  const [semanticItemsById, setSemanticItemsById] = createSignal<
    ReadonlyMap<string, SemanticSnapshotItem>
  >(new Map());
  const [mode, setMode] = createSignal<SaveMode>("normal");
  const [isLoading, setIsLoading] = createSignal(false);
  const [source, setSource] = createSignal<DisplayedSaveSource>({
    kind: "empty",
  });
  const hasSave = createMemo(() => decodedSave() !== undefined);

  const store: SaveStore = {
    decodedSave,
    hasSave,
    isLoading,
    async loadFile(file) {
      if (file === undefined) {
        return { message: "No file selected.", ok: false };
      }

      setIsLoading(true);
      try {
        const loadedSave = await loadCurrentSave(file);
        setDecodedSave(() => loadedSave.decodedSave);
        setSnapshot(loadedSave.snapshot);
        setSemanticItemsById(loadedSave.semanticItemsById);
        setMode(loadedSave.mode);
        setSource({ kind: "static" });

        return { ok: true };
      } catch (error) {
        console.error("[save] Decode error:", error);
        return { message: "Error processing save file.", ok: false };
      } finally {
        setIsLoading(false);
      }
    },
    loadLocalState(state, localSource) {
      if (state.status === "empty") {
        store.clear();
        setSource(localSource ?? { kind: "localLatest" });
        return;
      }

      setDecodedSave(state.decodedSave);
      setSnapshot(state.semanticSnapshot ?? undefined);
      setSemanticItemsById(
        new Map(
          (state.semanticSnapshot?.items ?? []).map((item) => [item.id, item]),
        ),
      );
      setMode(
        isSteelSoulMode(state.semanticSnapshot?.summary.permadeathMode)
          ? "steel"
          : "normal",
      );
      setSource(localSource ?? { kind: "localLatest" });
    },
    loadDecodedSave(decoded) {
      try {
        const loadedSave = loadDecodedSave(decoded);
        setDecodedSave(() => loadedSave.decodedSave);
        setSnapshot(loadedSave.snapshot);
        setSemanticItemsById(loadedSave.semanticItemsById);
        setMode(loadedSave.mode);
        setSource({ kind: "static" });
        return { ok: true };
      } catch (error) {
        console.error("[save] Parse error:", error);
        return { message: "Error processing save file.", ok: false };
      }
    },
    mode,
    semanticItem: (itemId) => semanticItemsById().get(itemId),
    snapshot,
    source,
    clear() {
      setDecodedSave(undefined);
      setSnapshot(undefined);
      setSemanticItemsById(new Map());
      setMode("normal");
      setSource({ kind: "empty" });
    },
  };

  return (
    <SaveContext.Provider value={store}>{props.children}</SaveContext.Provider>
  );
}

function isSteelSoulMode(permadeathMode: unknown): boolean {
  return [1, 2, 3, "Dead", "On"].includes(permadeathMode as never);
}

export function useSaveStore(): SaveStore {
  const store = useContext(SaveContext);
  if (store === undefined) {
    throw new Error("Save store is not available.");
  }

  return store;
}
