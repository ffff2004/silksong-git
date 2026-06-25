import { isArray } from "complete-common";

import type { DecodedSave, MappingItem } from "../types.ts";

export type SceneFlags = Record<string, Record<string, boolean>>;

export function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function findSavedDataEntryData(
  objectWithSavedData: unknown,
  name: string,
  options: { readonly normalizeName: boolean },
): Record<string, unknown> | undefined {
  if (!isRecord(objectWithSavedData)) {
    return undefined;
  }

  const { savedData } = objectWithSavedData;
  if (!isArray(savedData)) {
    return undefined;
  }

  const normalizedName = normalizeString(name);
  const entry = savedData.find((element) => {
    if (!isRecord(element) || typeof element["Name"] !== "string") {
      return false;
    }

    if (options.normalizeName) {
      return normalizeString(element["Name"]) === normalizedName;
    }

    return element["Name"] === name;
  });

  if (!isRecord(entry) || !isRecord(entry["Data"])) {
    return undefined;
  }

  return entry["Data"];
}

export function findJournalKills(journalData: unknown, name: string): number {
  if (!isRecord(journalData) || !isArray(journalData["list"])) {
    return 0;
  }

  const entry = journalData["list"].find(
    (element) => isRecord(element) && element["Name"] === name,
  );

  if (!isRecord(entry) || !isRecord(entry["Record"])) {
    return 0;
  }

  return getNumber(entry["Record"]["Kills"]) ?? 0;
}

export function getRelicState(
  data: Record<string, unknown> | undefined,
): false | "collected" | "deposited" {
  if (data?.["IsDeposited"] === true) {
    return "deposited";
  }

  if (
    data?.["HasSeenInRelicBoard"] === true
    || data?.["IsCollected"] === true
  ) {
    return "collected";
  }

  return false;
}

export function isSpecialSceneNumericItem(
  item: MappingItem,
): item is MappingItem & { readonly required: number } {
  return (
    item.type === "sceneBool"
    && (item.flag === "Shell Fossil Mimic"
      || item.flag === "Shell Fossil Mimic AppearVariant")
    && typeof item.required === "number"
  );
}

export function findSceneNumericValue(
  decodedSave: DecodedSave,
  item: { readonly flag: string; readonly scene: string },
): number | undefined {
  const { sceneData } = decodedSave;
  if (!isRecord(sceneData) || !isRecord(sceneData["persistentInts"])) {
    return undefined;
  }

  const { serializedList } = sceneData["persistentInts"];
  if (!isArray(serializedList)) {
    return undefined;
  }

  const element = serializedList.find(
    (candidate) =>
      isRecord(candidate)
      && candidate["SceneName"] === item.scene
      && candidate["ID"] === item.flag
      && typeof candidate["Value"] === "number",
  );

  if (!isRecord(element)) {
    return undefined;
  }

  return getNumber(element["Value"]);
}

export function getSceneFlags(root: unknown): SceneFlags {
  const flags: SceneFlags = {};

  function mark(scene: string, id: string, value: number | boolean) {
    const normalizedScene = normalizeStringWithUnderscores(scene);
    const normalizedId = normalizeStringWithUnderscores(id);

    flags[normalizedScene] ??= {};
    flags[normalizedScene][normalizedId] = Boolean(value);
  }

  const nodes: unknown[] = [root];
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    index++;

    if (isArray(node)) {
      for (const element of node) {
        nodes.push(element);
      }
      continue;
    }

    if (!isRecord(node)) {
      continue;
    }

    const { ID, SceneName, Value } = node;
    if (
      typeof SceneName === "string"
      && typeof ID === "string"
      && (typeof Value === "boolean" || typeof Value === "number")
    ) {
      mark(SceneName, ID, Value);
    }

    for (const value of Object.values(node)) {
      nodes.push(value);
    }
  }

  return flags;
}

export function normalizeStringWithUnderscores(value: string): string {
  return normalizeWords(value, { lowercase: false, separator: "_" });
}

function normalizeString(value: string): string {
  return normalizeWords(value, { lowercase: true, separator: " " });
}

function normalizeWords(
  value: string,
  options: { readonly lowercase: boolean; readonly separator: string },
): string {
  const words: string[] = [];
  let currentWord = "";
  const normalizedValue = options.lowercase ? value.toLowerCase() : value;

  for (const character of normalizedValue.trim()) {
    if (character.trim() === "") {
      if (currentWord !== "") {
        words.push(currentWord);
        currentWord = "";
      }
      continue;
    }

    currentWord += character;
  }

  if (currentWord !== "") {
    words.push(currentWord);
  }

  return words.join(options.separator);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
