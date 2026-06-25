import { isArray } from "complete-common";

import type {
  MappingItem,
  MappingItemCheck,
  SemanticSnapshotItem,
  SemanticSnapshotItemStatus,
} from "../types.ts";
import {
  findJournalKills,
  findSavedDataEntryData,
  findSceneNumericValue,
  getNumber,
  getRelicState,
  isSpecialSceneNumericItem,
  normalizeStringWithUnderscores,
} from "./decoded-save-readers.ts";
import type { SnapshotCreationContext } from "./snapshot-creation-context.ts";
import { createSourceReferences } from "./source-references.ts";

export function createSnapshotItem(
  context: SnapshotCreationContext,
  item: MappingItem,
  sectionId: string,
  categoryId: string,
): SemanticSnapshotItem {
  const value = readItemValue(context, item);
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

function readItemValue(
  context: SnapshotCreationContext,
  item: MappingItem,
): unknown {
  const { decodedSave } = context;

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

    case "quest": {
      const data = findSavedDataEntryData(
        decodedSave.playerData["QuestCompletionData"],
        item.flag,
        { normalizeName: true },
      );

      if (data?.["IsCompleted"] === true) {
        return "completed";
      }

      if (data?.["IsAccepted"] === true) {
        return "accepted";
      }

      return false;
    }

    case "journal": {
      return findJournalKills(
        decodedSave.playerData["EnemyJournalKillData"],
        item.flag,
      );
    }

    case "relic": {
      const data =
        findSavedDataEntryData(decodedSave.playerData["Relics"], item.flag, {
          normalizeName: false,
        })
        ?? findSavedDataEntryData(
          decodedSave.playerData["MementosDeposited"],
          item.flag,
          { normalizeName: false },
        );

      return getRelicState(data);
    }

    case "materium": {
      const data = findSavedDataEntryData(
        decodedSave.playerData["MateriumCollected"],
        item.flag,
        { normalizeName: false },
      );

      if (data?.["HasSeenInRelicBoard"] === true) {
        return "deposited";
      }

      if (data?.["IsCollected"] === true) {
        return "collected";
      }

      return false;
    }

    case "device": {
      if (decodedSave.playerData[item.relatedFlag] === true) {
        return "deposited";
      }

      const sceneFlags = context.getSceneFlags();
      const normalizedScene = normalizeStringWithUnderscores(item.scene);
      const normalizedFlag = normalizeStringWithUnderscores(item.flag);

      if (sceneFlags[normalizedScene]?.[normalizedFlag] === true) {
        return "collected";
      }

      return false;
    }

    case "sceneVisited": {
      const { scenesVisited } = decodedSave.playerData;

      return isArray(scenesVisited) && scenesVisited.includes(item.scene);
    }

    case "quill": {
      if (decodedSave.playerData["hasQuill"] !== true) {
        return 0;
      }

      return getNumber(decodedSave.playerData[item.flag]) ?? 0;
    }

    case "anyOf": {
      return item.anyOf.map((check) => readCheckValue(context, check));
    }

    case "sceneBool": {
      if (isSpecialSceneNumericItem(item)) {
        return item.required === findSceneNumericValue(decodedSave, item);
      }

      const sceneFlags = context.getSceneFlags();
      const normalizedScene = normalizeStringWithUnderscores(item.scene);
      const normalizedFlag = normalizeStringWithUnderscores(item.flag);

      return sceneFlags[normalizedScene]?.[normalizedFlag] ?? false;
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

    case "quest": {
      if (value === "completed" || value === true) {
        return "done";
      }

      return value === "accepted" ? "accepted" : "missing";
    }

    case "journal": {
      const numberValue = typeof value === "number" ? value : 0;

      if (numberValue >= item.required) {
        return "done";
      }

      return numberValue > 0 ? "accepted" : "missing";
    }

    case "relic":
    case "materium":
    case "device": {
      if (value === "deposited") {
        return "done";
      }

      return value === "collected" ? "accepted" : "missing";
    }

    case "quill": {
      const numberValue = typeof value === "number" ? value : 0;

      return item.id === `QuillState_${numberValue}`
        && [1, 2, 3].includes(numberValue)
        ? "done"
        : "missing";
    }

    case "anyOf": {
      const checkValues = isArray(value) ? value : [];
      const hasDoneCheck = item.anyOf.some((check, index) =>
        isCheckDone(check, checkValues[index]),
      );

      return hasDoneCheck ? "done" : "missing";
    }

    default: {
      return value === true ? "done" : "missing";
    }
  }
}

function readCheckValue(
  context: SnapshotCreationContext,
  check: MappingItemCheck,
): unknown {
  const { decodedSave } = context;

  switch (check.type) {
    case "flag": {
      return decodedSave.playerData[check.flag] === true;
    }

    case "flagInt": {
      return getNumber(decodedSave.playerData[check.flag]) ?? 0;
    }

    case "level": {
      return getNumber(decodedSave.playerData[check.flag]) ?? 0;
    }

    case "sceneBool": {
      const sceneFlags = context.getSceneFlags();
      const normalizedScene = normalizeStringWithUnderscores(check.scene);
      const normalizedFlag = normalizeStringWithUnderscores(check.flag);

      return sceneFlags[normalizedScene]?.[normalizedFlag] ?? false;
    }

    case "sceneVisited": {
      const { scenesVisited } = decodedSave.playerData;

      return isArray(scenesVisited) && scenesVisited.includes(check.scene);
    }
  }
}

function isCheckDone(check: MappingItemCheck, value: unknown): boolean {
  switch (check.type) {
    case "flag":
    case "sceneBool":
    case "sceneVisited": {
      return value === true;
    }

    case "flagInt": {
      const numberValue = typeof value === "number" ? value : 0;

      return numberValue >= 1;
    }

    case "level": {
      const numberValue = typeof value === "number" ? value : 0;

      return numberValue >= check.required;
    }
  }
}
