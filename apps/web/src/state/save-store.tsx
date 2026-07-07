import type {
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import type { JSX } from "solid-js";
import { createContext, createMemo, createSignal, useContext } from "solid-js";

import type { SaveMode } from "../features/current-save/load-current-save.ts";
import { loadCurrentSave } from "../features/current-save/load-current-save.ts";

interface SaveStore {
  readonly decodedSave: () => unknown;
  readonly hasSave: () => boolean;
  readonly isLoading: () => boolean;
  readonly loadFile: (file: File | undefined) => Promise<LoadFileResult>;
  readonly mode: () => SaveMode;
  readonly semanticItem: (itemId: string) => SemanticSnapshotItem | undefined;
  readonly snapshot: () => SemanticSnapshot | undefined;
  readonly clear: () => void;
}

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

        return { ok: true };
      } catch (error) {
        console.error("[save] Decode error:", error);
        return { message: "Error processing save file.", ok: false };
      } finally {
        setIsLoading(false);
      }
    },
    mode,
    semanticItem: (itemId) => semanticItemsById().get(itemId),
    snapshot,
    clear() {
      setDecodedSave(undefined);
      setSnapshot(undefined);
      setSemanticItemsById(new Map());
      setMode("normal");
    },
  };

  return (
    <SaveContext.Provider value={store}>{props.children}</SaveContext.Provider>
  );
}

export function useSaveStore(): SaveStore {
  const store = useContext(SaveContext);
  if (store === undefined) {
    throw new Error("Save store is not available.");
  }

  return store;
}
