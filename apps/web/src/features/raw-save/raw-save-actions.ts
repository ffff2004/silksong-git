import { downloadJsonFile } from "../../utils/download.ts";

export function getRawSaveJson(decodedSave: unknown): string {
  if (decodedSave === undefined) {
    return "No save file loaded.";
  }

  return JSON.stringify(decodedSave, undefined, 2);
}

export function downloadRawSaveJson(decodedSave: unknown): void {
  downloadJsonFile({
    filename: "silksong-save.json",
    value: decodedSave,
  });
}
