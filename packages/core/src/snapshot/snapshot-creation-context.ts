import type { DecodedSave } from "../types.ts";
import type { SceneFlags } from "./decoded-save-readers.ts";
import { getSceneFlags } from "./decoded-save-readers.ts";

export interface SnapshotCreationContext {
  readonly decodedSave: DecodedSave;
  getSceneFlags: () => SceneFlags;
}

export function createSnapshotCreationContext(
  decodedSave: DecodedSave,
): SnapshotCreationContext {
  let sceneFlags: SceneFlags | undefined;

  return {
    decodedSave,
    getSceneFlags() {
      sceneFlags ??= getSceneFlags(decodedSave);

      return sceneFlags;
    },
  };
}
