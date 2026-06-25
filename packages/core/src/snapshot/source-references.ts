import type {
  MappingItem,
  MappingItemCheck,
  SourceReference,
} from "../types.ts";

export function createSourceReferences(
  item: MappingItem,
): readonly SourceReference[] {
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

    case "quest": {
      return [
        {
          kind: "savedData",
          field: "QuestCompletionData",
          name: item.flag,
        },
      ];
    }

    case "journal": {
      return [
        {
          kind: "playerData",
          field: "EnemyJournalKillData",
        },
      ];
    }

    case "relic": {
      return ["Relics", "MementosDeposited"].map((field) => ({
        kind: "savedData",
        field,
        name: item.flag,
      }));
    }

    case "materium": {
      return [
        {
          kind: "savedData",
          field: "MateriumCollected",
          name: item.flag,
        },
      ];
    }

    case "device": {
      return [
        {
          kind: "playerData",
          field: item.relatedFlag,
        },
        {
          kind: "sceneFlag",
          scene: item.scene,
          flag: item.flag,
        },
      ];
    }

    case "sceneVisited": {
      return [
        {
          kind: "playerData",
          field: "scenesVisited",
        },
      ];
    }

    case "quill": {
      return [
        {
          kind: "playerData",
          field: "hasQuill",
        },
        {
          kind: "playerData",
          field: item.flag,
        },
      ];
    }

    case "anyOf": {
      return item.anyOf.flatMap((check) => createCheckSourceReferences(check));
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

function createCheckSourceReferences(
  check: MappingItemCheck,
): readonly SourceReference[] {
  switch (check.type) {
    case "flag":
    case "flagInt":
    case "level": {
      return [
        {
          kind: "playerData",
          field: check.flag,
        },
      ];
    }

    case "sceneBool": {
      return [
        {
          kind: "sceneFlag",
          scene: check.scene,
          flag: check.flag,
        },
      ];
    }

    case "sceneVisited": {
      return [
        {
          kind: "playerData",
          field: "scenesVisited",
        },
      ];
    }
  }
}
