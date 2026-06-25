import { isArray } from "complete-common";

import type {
  DecodedSave,
  MappingData,
  MappingItem,
  SaveSummaryMetrics,
  SemanticSnapshot,
  SemanticSnapshotItem,
  SemanticSnapshotItemStatus,
  SnapshotOptions,
  SourceReference,
} from "../types.ts";

export function createSemanticSnapshot(
  decodedSave: DecodedSave,
  mappingData: MappingData,
  options: SnapshotOptions = {},
): SemanticSnapshot {
  const items: SemanticSnapshotItem[] = [];

  for (const section of mappingData.sections) {
    for (const category of section.categories) {
      for (const item of category.items) {
        items.push(
          createSnapshotItem(decodedSave, item, section.id, category.id),
        );
      }
    }
  }

  return {
    items,
    summary: createSummaryMetrics(decodedSave),
    version: {
      saveSchemaVersion: options.saveSchemaVersion,
      gameVersion: options.gameVersion,
      platform: options.platform,
      platformBuildId: options.platformBuildId,
      mappingDataVersion: mappingData.version,
      semanticCoreVersion: options.semanticCoreVersion,
      configHash: options.configHash,
    },
  };
}

function createSnapshotItem(
  decodedSave: DecodedSave,
  item: MappingItem,
  sectionId: string,
  categoryId: string,
): SemanticSnapshotItem {
  const value = readItemValue(decodedSave, item);
  const status = getItemStatus(item, value);

  return {
    id: item.id,
    label: item.label,
    sectionId,
    categoryId,
    type: item.type,
    status,
    value,
    sourceReferences: createSourceReferences(item),
  };
}

function readItemValue(decodedSave: DecodedSave, item: MappingItem): unknown {
  switch (item.type) {
    case "flag":
    case "boss": {
      return decodedSave.playerData[item.flag] === true;
    }

    case "key": {
      if (item.flags !== undefined) {
        return item.flags.some((flag) => decodedSave.playerData[flag] === true);
      }

      return (
        item.flag !== undefined && decodedSave.playerData[item.flag] === true
      );
    }

    case "level": {
      return getNumber(decodedSave.playerData[item.flag]) ?? 0;
    }

    case "flagInt": {
      const current = decodedSave.playerData[item.flag];

      return typeof current === "number" ? current >= 1 : false;
    }

    case "collectable": {
      const data = findSavedDataEntryData(
        decodedSave.playerData["Collectables"],
        item.flag,
        { normalizeName: false },
      );

      return getNumber(data?.["Amount"]) ?? 0;
    }

    case "tool": {
      const data =
        findSavedDataEntryData(decodedSave.playerData["Tools"], item.flag, {
          normalizeName: true,
        })
        ?? findSavedDataEntryData(
          decodedSave.playerData["ToolEquips"],
          item.flag,
          {
            normalizeName: true,
          },
        );

      return data?.["IsUnlocked"] === true;
    }

    case "sceneBool": {
      const sceneFlags = getSceneFlags(decodedSave);
      const normalizedScene = normalizeStringWithUnderscores(item.scene);
      const normalizedFlag = normalizeStringWithUnderscores(item.flag);

      return sceneFlags[normalizedScene]?.[normalizedFlag] ?? false;
    }
  }
}

function createSourceReferences(item: MappingItem): readonly SourceReference[] {
  switch (item.type) {
    case "flag":
    case "boss": {
      return [
        {
          kind: "playerData",
          field: item.flag,
        },
      ];
    }

    case "key": {
      const fields = item.flags ?? (item.flag === undefined ? [] : [item.flag]);

      return fields.map((field) => ({
        kind: "playerData",
        field,
      }));
    }

    case "level":
    case "flagInt": {
      return [
        {
          kind: "playerData",
          field: item.flag,
        },
      ];
    }

    case "collectable": {
      return [
        {
          kind: "savedData",
          field: "Collectables",
          name: item.flag,
        },
      ];
    }

    case "tool": {
      return ["Tools", "ToolEquips"].map((field) => ({
        kind: "savedData",
        field,
        name: item.flag,
      }));
    }

    case "sceneBool": {
      return [
        {
          kind: "sceneFlag",
          scene: item.scene,
          flag: item.flag,
        },
      ];
    }
  }
}

function getItemStatus(
  item: MappingItem,
  value: unknown,
): SemanticSnapshotItemStatus {
  switch (item.type) {
    case "level": {
      const numberValue = typeof value === "number" ? value : 0;

      return numberValue >= (item.required ?? 0) ? "done" : "missing";
    }

    case "collectable": {
      const numberValue = typeof value === "number" ? value : 0;

      return numberValue > 0 ? "done" : "missing";
    }

    default: {
      return value === true ? "done" : "missing";
    }
  }
}

function createSummaryMetrics(decodedSave: DecodedSave): SaveSummaryMetrics {
  const { playerData } = decodedSave;

  return {
    completionPercentage: getNumber(playerData["completionPercentage"]),
    playTime: getNumber(playerData["playTime"]),
    rosaries: getNumber(playerData["geo"]),
    shellShards: getNumber(playerData["ShellShards"]),
    permadeathMode: playerData["permadeathMode"],
  };
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function findSavedDataEntryData(
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

function getSceneFlags(root: unknown): Record<string, Record<string, boolean>> {
  const flags: Record<string, Record<string, boolean>> = {};

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

function normalizeStringWithUnderscores(value: string): string {
  const words: string[] = [];
  let currentWord = "";

  for (const character of value.trim()) {
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

  return words.join("_");
}

function normalizeString(value: string): string {
  const words: string[] = [];
  let currentWord = "";

  for (const character of value.toLowerCase().trim()) {
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

  return words.join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
