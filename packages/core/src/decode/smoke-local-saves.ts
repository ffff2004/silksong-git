import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  createSemanticSnapshot,
  decodeEncodedSave,
  getBuiltinMappingData,
  parseDecodedSave,
} from "../index.ts";

const saveDirectory = process.env["SILKSONG_SAVE_DIR"];

if (saveDirectory === undefined || saveDirectory.trim() === "") {
  throw new Error("Set SILKSONG_SAVE_DIR to a local Silksong save directory.");
}

const checkedSaveDirectory = saveDirectory;
const directoryEntries = await readdir(checkedSaveDirectory);
const fileNames = directoryEntries
  .filter(
    (fileName) => fileName.startsWith("user") && fileName.endsWith(".dat"),
  )
  .toSorted();

if (fileNames.length === 0) {
  throw new Error(`No user*.dat files found in ${saveDirectory}.`);
}

const mappingData = getBuiltinMappingData();
const results = await Promise.all(fileNames.map(readLocalSaveSummary));

for (const result of results) {
  console.log(JSON.stringify(result));
}

async function readLocalSaveSummary(fileName: string) {
  const encodedSave = await readFile(path.join(checkedSaveDirectory, fileName));
  const decodedSave = decodeEncodedSave(encodedSave);
  const parsedSave = parseDecodedSave(decodedSave);
  const snapshot = createSemanticSnapshot(parsedSave, mappingData);

  return {
    fileName,
    itemCount: snapshot.items.length,
    summary: snapshot.summary,
  };
}
