import type {
  ParsedDecodedSave,
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import {
  UnrecognizedSaveSchemaError,
  createSemanticSnapshot,
  decodeEncodedSave,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";

export interface LoadedCurrentSave {
  readonly decodedSave: unknown;
  readonly parsedSave: ParsedDecodedSave;
  readonly snapshot: SemanticSnapshot;
  readonly semanticItemsById: ReadonlyMap<string, SemanticSnapshotItem>;
  readonly mode: SaveMode;
}

export type SaveMode = "normal" | "steel";

class LoadCurrentSaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LoadCurrentSaveError";
  }
}

export async function loadCurrentSave(file: File): Promise<LoadedCurrentSave> {
  const buffer = await file.arrayBuffer();
  const decodedSave = file.name.toLowerCase().endsWith(".json")
    ? parseRawDecodedSaveJson(buffer)
    : decodeEncodedSave(buffer).decodedSave;

  return loadDecodedSave(decodedSave);
}

/** Shared Static Save pipeline after an adapter has obtained a decoded value. */
export function loadDecodedSave(decodedSave: unknown): LoadedCurrentSave {
  let parsedSave: ParsedDecodedSave;
  try {
    parsedSave = parseDecodedSave(decodedSave);
  } catch (error) {
    if (error instanceof UnrecognizedSaveSchemaError) {
      throw new LoadCurrentSaveError("Invalid or corrupted save file", {
        cause: error,
      });
    }

    throw error;
  }

  const snapshot = createSemanticSnapshot(parsedSave, getBuiltinMappingData());
  const semanticItemsById = new Map(
    snapshot.items.map((item) => [item.id, item]),
  );

  return {
    decodedSave,
    parsedSave,
    snapshot,
    semanticItemsById,
    mode: isSteelSoulMode(snapshot.summary.permadeathMode) ? "steel" : "normal",
  };
}

function parseRawDecodedSaveJson(buffer: ArrayBuffer): unknown {
  try {
    const decoder = new TextDecoder("utf-8");
    return JSON.parse(decoder.decode(buffer));
  } catch (error) {
    throw new LoadCurrentSaveError("Invalid or corrupted save file", {
      cause: error,
    });
  }
}

function isSteelSoulMode(permadeathMode: unknown): boolean {
  return [1, 2, 3, "Dead", "On"].includes(permadeathMode as never);
}
