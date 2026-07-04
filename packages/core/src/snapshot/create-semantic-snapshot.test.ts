import { strict as assert } from "node:assert";
import test from "node:test";

import type {
  DecodedSave,
  MappingData,
  ParsedDecodedSave,
  SemanticSnapshot,
  SemanticSnapshotItemStatus,
  SourceReference,
} from "../index.ts";
import { createSemanticSnapshot, getBuiltinMappingData } from "../index.ts";

type MappingItem =
  MappingData["sections"][number]["categories"][number]["items"][number];

test("createSemanticSnapshot marks a scene-scoped collected item as done", () => {
  const decodedSave: DecodedSave = {
    playerData: {},
    sceneData: {},
    sceneState: {
      serializedList: [
        {
          ID: "Heart Piece",
          SceneName: "Crawl_02",
          Value: true,
        },
      ],
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping([
      sceneBoolItem("mask-shard-2", "Mask Shard #2", {
        flag: "Heart Piece",
        scene: "Crawl_02",
      }),
    ]),
  );

  assertSnapshotItem(snapshot, "mask-shard-2", {
    sourceReferences: [
      {
        flag: "Heart Piece",
        kind: "sceneFlag",
        scene: "Crawl_02",
      },
    ],
    status: "done",
    value: true,
  });
});

test("createSemanticSnapshot marks an untriggered scene-scoped item as missing", () => {
  const decodedSave: DecodedSave = {
    playerData: {},
    sceneData: {},
    sceneState: {
      serializedList: [
        {
          ID: "Other Pickup",
          SceneName: "Crawl_02",
          Value: true,
        },
      ],
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping([
      sceneBoolItem("mask-shard-2", "Mask Shard #2", {
        flag: "Heart Piece",
        scene: "Crawl_02",
      }),
    ]),
  );

  assertSnapshotItem(snapshot, "mask-shard-2", {
    sourceReferences: [
      {
        flag: "Heart Piece",
        kind: "sceneFlag",
        scene: "Crawl_02",
      },
    ],
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps direct playerData booleans to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      defeatedBellBeast: true,
      defeatedMoorwing: false,
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        flagItem("bell-beast", "Bell Beast", "defeatedBellBeast"),
        bossItem("moorwing", "Moorwing", "defeatedMoorwing"),
      ],
      { categoryId: "bosses", categoryLabel: "Bosses", sectionId: "bosses" },
    ),
  );

  assertSnapshotItem(snapshot, "bell-beast", {
    sourceReferences: [
      {
        field: "defeatedBellBeast",
        kind: "playerData",
      },
    ],
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "moorwing", {
    sourceReferences: [
      {
        field: "defeatedMoorwing",
        kind: "playerData",
      },
    ],
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps key flags to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      hasCityKey: true,
      hasSimpleKeyA: false,
      hasSimpleKeyB: true,
      hasSimpleKeyC: false,
      hasUnusedKey: false,
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        keyItem("city-key", "City Key", { flag: "hasCityKey" }),
        keyItem("simple-key", "Simple Key", {
          flags: ["hasSimpleKeyA", "hasSimpleKeyB"],
        }),
        keyItem("unused-key", "Unused Key", { flag: "hasUnusedKey" }),
      ],
      {
        categoryId: "keys",
        categoryLabel: "Keys",
        sectionId: "essentials",
        sectionLabel: "Essentials",
      },
    ),
  );

  assertSnapshotItem(snapshot, "city-key", {
    sourceReferences: [
      {
        field: "hasCityKey",
        kind: "playerData",
      },
    ],
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "simple-key", {
    sourceReferences: [
      {
        field: "hasSimpleKeyA",
        kind: "playerData",
      },
      {
        field: "hasSimpleKeyB",
        kind: "playerData",
      },
    ],
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "unused-key", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps numeric thresholds to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      bellKeyCount: 1,
      nailUpgrades: 2,
      simpleKeyCount: 0,
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        levelItem("base-needle", "Base Needle", "nailUpgrades", 0),
        levelItem("shining-needle", "Shining Needle", "nailUpgrades", 2),
        levelItem("hivesteel-needle", "Hivesteel Needle", "nailUpgrades", 3),
        flagIntItem("bell-key", "Bell Key", "bellKeyCount"),
        flagIntItem("simple-key-count", "Simple Key Count", "simpleKeyCount"),
      ],
      { categoryId: "needle-upgrades", categoryLabel: "Needle Upgrades" },
    ),
  );

  assertSnapshotItem(snapshot, "base-needle", {
    status: "done",
    value: 2,
  });
  assertSnapshotItem(snapshot, "shining-needle", {
    status: "done",
    value: 2,
  });
  assertSnapshotItem(snapshot, "hivesteel-needle", {
    sourceReferences: [
      {
        field: "nailUpgrades",
        kind: "playerData",
      },
    ],
    status: "missing",
    value: 2,
  });
  assertSnapshotItem(snapshot, "bell-key", {
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "simple-key-count", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps savedData quantity and unlocked entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      Collectables: {
        savedData: [
          {
            Name: "Mossberry",
            Data: {
              Amount: 2,
            },
          },
          {
            Name: "Memory Locket",
            Data: {
              Amount: 0,
            },
          },
        ],
      },
      ToolEquips: {
        savedData: [
          {
            Name: "Straight  Pin",
            Data: {
              IsUnlocked: true,
            },
          },
        ],
      },
      Tools: {
        savedData: [
          {
            Name: "Compass",
            Data: {
              IsUnlocked: false,
            },
          },
        ],
      },
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping([
      collectableItem("mossberry", "Mossberry", "Mossberry"),
      collectableItem("memory-locket", "Memory Locket", "Memory Locket"),
      toolItem("straight-pin", "Straight Pin", "Straight Pin"),
      toolItem("compass", "Compass", "Compass"),
    ]),
  );

  assertSnapshotItem(snapshot, "mossberry", {
    sourceReferences: [
      {
        field: "Collectables",
        kind: "savedData",
        name: "Mossberry",
      },
    ],
    status: "done",
    value: 2,
  });
  assertSnapshotItem(snapshot, "memory-locket", {
    status: "missing",
    value: 0,
  });
  assertSnapshotItem(snapshot, "straight-pin", {
    sourceReferences: [
      {
        field: "Tools",
        kind: "savedData",
        name: "Straight Pin",
      },
      {
        field: "ToolEquips",
        kind: "savedData",
        name: "Straight Pin",
      },
    ],
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "compass", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps quest states to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      QuestCompletionData: {
        savedData: [
          {
            Name: "Citadel Seeker",
            Data: {
              IsAccepted: true,
              IsCompleted: false,
            },
          },
          {
            Name: "Lost Merchant",
            Data: {
              IsAccepted: true,
              IsCompleted: true,
            },
          },
          {
            Name: "Quiet Wish",
            Data: {
              IsAccepted: false,
              IsCompleted: false,
            },
          },
        ],
      },
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        questItem("citadel-seeker", "Citadel Seeker", "Citadel   Seeker"),
        questItem("lost-merchant", "Lost Merchant", "Lost Merchant"),
        questItem("quiet-wish", "Quiet Wish", "Quiet Wish"),
      ],
      {
        categoryId: "wishes",
        categoryLabel: "Wishes",
        sectionId: "wishes",
        sectionLabel: "Wishes",
      },
    ),
  );

  assertSnapshotItem(snapshot, "citadel-seeker", {
    sourceReferences: [
      {
        field: "QuestCompletionData",
        kind: "savedData",
        name: "Citadel   Seeker",
      },
    ],
    status: "accepted",
    value: "accepted",
  });
  assertSnapshotItem(snapshot, "lost-merchant", {
    status: "done",
    value: "completed",
  });
  assertSnapshotItem(snapshot, "quiet-wish", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps journal progress to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      EnemyJournalKillData: {
        list: [
          {
            Name: "Moss Charger",
            Record: {
              Kills: 2,
            },
          },
          {
            Name: "Bell Beast",
            Record: {
              Kills: 5,
            },
          },
        ],
      },
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        journalItem("moss-charger", "Moss Charger", "Moss Charger", 5),
        journalItem("bell-beast-journal", "Bell Beast", "Bell Beast", 5),
        journalItem("missing-entry", "Missing Entry", "Missing Entry", 1),
      ],
      { categoryId: "journal", categoryLabel: "Journal", sectionId: "journal" },
    ),
  );

  assertSnapshotItem(snapshot, "moss-charger", {
    sourceReferences: [
      {
        field: "EnemyJournalKillData",
        kind: "playerData",
      },
    ],
    status: "accepted",
    value: 2,
  });
  assertSnapshotItem(snapshot, "bell-beast-journal", {
    status: "done",
    value: 5,
  });
  assertSnapshotItem(snapshot, "missing-entry", {
    status: "missing",
    value: 0,
  });
});

test("createSemanticSnapshot maps relic, materium, and device states to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      MateriumCollected: {
        savedData: [
          {
            Name: "Far Fields Materium",
            Data: {
              IsCollected: true,
            },
          },
          {
            Name: "Deposited Materium",
            Data: {
              HasSeenInRelicBoard: true,
            },
          },
        ],
      },
      MementosDeposited: {
        savedData: [
          {
            Name: "Choral Commandment",
            Data: {
              IsDeposited: true,
            },
          },
        ],
      },
      Relics: {
        savedData: [
          {
            Name: "Rune Harp",
            Data: {
              IsCollected: true,
            },
          },
        ],
      },
      depositedDevice: true,
    },
    sceneState: {
      serializedList: [
        {
          ID: "Device Pickup",
          SceneName: "Device_Room",
          Value: true,
        },
      ],
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        relicItem(
          "choral-commandment",
          "Choral Commandment",
          "Choral Commandment",
        ),
        relicItem("rune-harp", "Rune Harp", "Rune Harp"),
        materiumItem(
          "far-fields-materium",
          "Far Fields Materium",
          "Far Fields Materium",
        ),
        materiumItem(
          "deposited-materium",
          "Deposited Materium",
          "Deposited Materium",
        ),
        deviceItem("collected-device", "Collected Device", {
          flag: "Device Pickup",
          relatedFlag: "otherDepositedDevice",
          scene: "Device_Room",
        }),
        deviceItem("deposited-device", "Deposited Device", {
          flag: "Missing Device Pickup",
          relatedFlag: "depositedDevice",
          scene: "Device_Room",
        }),
      ],
      {
        categoryId: "relics",
        categoryLabel: "Relics",
        sectionId: "completion",
        sectionLabel: "Completion",
      },
    ),
  );

  assertSnapshotItem(snapshot, "choral-commandment", {
    status: "done",
    value: "deposited",
  });
  assertSnapshotItem(snapshot, "rune-harp", {
    status: "accepted",
    value: "collected",
  });
  assertSnapshotItem(snapshot, "far-fields-materium", {
    status: "accepted",
    value: "collected",
  });
  assertSnapshotItem(snapshot, "deposited-materium", {
    status: "done",
    value: "deposited",
  });
  assertSnapshotItem(snapshot, "collected-device", {
    sourceReferences: [
      {
        field: "otherDepositedDevice",
        kind: "playerData",
      },
      {
        kind: "sceneFlag",
        flag: "Device Pickup",
        scene: "Device_Room",
      },
    ],
    status: "accepted",
    value: "collected",
  });
  assertSnapshotItem(snapshot, "deposited-device", {
    status: "done",
    value: "deposited",
  });
});

test("createSemanticSnapshot maps sceneVisited entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      scenesVisited: ["Crawl_02", "Dock_08"],
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        sceneVisitedItem("crawl-02", "Crawl 02", "Crawl_02"),
        sceneVisitedItem("song-09", "Song 09", "Song_09"),
      ],
      { categoryId: "scenes", categoryLabel: "Scenes", sectionId: "scenes" },
    ),
  );

  assertSnapshotItem(snapshot, "crawl-02", {
    sourceReferences: [
      {
        field: "scenesVisited",
        kind: "playerData",
      },
    ],
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "song-09", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps quill entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      hasQuill: true,
      QuillState: 2,
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        quillItem("QuillState_2", "Quill Entry 2", "QuillState"),
        quillItem("QuillState_3", "Quill Entry 3", "QuillState"),
      ],
      { categoryId: "quill", categoryLabel: "Quill" },
    ),
  );

  assertSnapshotItem(snapshot, "QuillState_2", {
    sourceReferences: [
      {
        field: "hasQuill",
        kind: "playerData",
      },
      {
        field: "QuillState",
        kind: "playerData",
      },
    ],
    status: "done",
    value: 2,
  });
  assertSnapshotItem(snapshot, "QuillState_3", {
    status: "missing",
    value: 2,
  });
});

test("createSemanticSnapshot maps anyOf entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      pinGalleriesCompleted: 0,
    },
    sceneState: {
      serializedList: [
        {
          ID: "Ladybug Craft Pickup",
          SceneName: "Bone_12",
          Value: true,
        },
      ],
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        {
          type: "anyOf",
          anyOf: [
            {
              type: "level",
              flag: "pinGalleriesCompleted",
              required: 1,
            },
            {
              type: "sceneBool",
              flag: "Ladybug Craft Pickup",
              scene: "Bone_12",
            },
          ],
          id: "tool-pouch-2",
          label: "Tool Pouch Upgrade #2",
        },
        {
          type: "anyOf",
          anyOf: [
            {
              type: "level",
              flag: "pinGalleriesCompleted",
              required: 1,
            },
            {
              type: "sceneBool",
              flag: "Missing Pickup",
              scene: "Bone_12",
            },
          ],
          id: "missing-upgrade",
          label: "Missing Upgrade",
        },
      ],
      { categoryId: "tool-pouch", categoryLabel: "Tool Pouch" },
    ),
  );

  assertSnapshotItem(snapshot, "tool-pouch-2", {
    sourceReferences: [
      {
        field: "pinGalleriesCompleted",
        kind: "playerData",
      },
      {
        kind: "sceneFlag",
        flag: "Ladybug Craft Pickup",
        scene: "Bone_12",
      },
    ],
    status: "done",
    value: [0, true],
  });
  assertSnapshotItem(snapshot, "missing-upgrade", {
    status: "missing",
    value: [0, false],
  });
});

test("createSemanticSnapshot supports Shell Fossil Mimic scene numeric entries", () => {
  const decodedSave: DecodedSave = {
    playerData: {},
    sceneData: {
      persistentInts: {
        serializedList: [
          {
            ID: "Shell Fossil Mimic",
            SceneName: "Fossil_Room",
            Value: 2,
          },
        ],
      },
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createMapping(
      [
        sceneBoolItem("visible-mimic", "Visible Mimic", {
          flag: "Shell Fossil Mimic",
          required: 2,
          scene: "Fossil_Room",
        }),
        sceneBoolItem("wrong-mimic-variant", "Wrong Mimic Variant", {
          flag: "Shell Fossil Mimic",
          required: 3,
          scene: "Fossil_Room",
        }),
        sceneBoolItem("missing-mimic", "Missing Mimic", {
          flag: "Shell Fossil Mimic AppearVariant",
          required: 1,
          scene: "Fossil_Room",
        }),
      ],
      {
        categoryId: "special",
        categoryLabel: "Special",
        sectionId: "completion",
        sectionLabel: "Completion",
      },
    ),
  );

  assertSnapshotItem(snapshot, "visible-mimic", {
    status: "done",
    value: true,
  });
  assertSnapshotItem(snapshot, "wrong-mimic-variant", {
    status: "missing",
    value: false,
  });
  assertSnapshotItem(snapshot, "missing-mimic", {
    status: "missing",
    value: false,
  });
});

test("createSemanticSnapshot maps raw summary fields to semantic summary metrics", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      completionPercentage: 12,
      geo: 34,
      playTime: 56,
      ShellShards: 7,
    },
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave),
    createEmptyMapping(),
  );

  assert.equal(snapshot.summary.completionPercentage, 12);
  assert.equal(snapshot.summary.playTime, 56);
  assert.equal(snapshot.summary.rosaries, 34);
  assert.equal(snapshot.summary.shellShards, 7);
  assert.equal("geo" in snapshot.summary, false);
  assert.equal("ShellShards" in snapshot.summary, false);
});

test("createSemanticSnapshot includes semantic version stamps", () => {
  const decodedSave: DecodedSave = {
    playerData: {},
  };

  const snapshot = createSemanticSnapshot(
    createParsedSave(decodedSave, {
      gameVersion: "1.0.30000",
      platform: "steam",
      platformBuildId: "22479045",
      saveSchemaVersion: "silksong-save-v1",
    }),
    createEmptyMapping(),
    {
      configHash: "config-hash",
    },
  );

  assert.deepEqual(snapshot.version, {
    configHash: "config-hash",
    gameVersion: "1.0.30000",
    mappingDataVersion: "fixture-v1",
    platform: "steam",
    platformBuildId: "22479045",
    saveSchemaVersion: "silksong-save-v1",
    semanticCoreVersion: "core-semantic-v1",
  });
});

test("getBuiltinMappingData exposes the current Web mapping tables", () => {
  const mappingData = getBuiltinMappingData();
  const sectionIds = mappingData.sections.map((section) => section.id);

  assert.deepEqual(sectionIds, [
    "main",
    "essentials",
    "bosses",
    "mini-bosses",
    "completion",
    "wishes",
    "journal",
    "scenes",
  ]);

  const snapshot = createSemanticSnapshot(
    createParsedSave({
      playerData: {},
      sceneData: {},
    }),
    mappingData,
  );

  assert.ok(snapshot.items.some((item) => item.id === "mask-shard-1"));
  assert.ok(snapshot.items.some((item) => item.sectionId === "scenes"));
});

function createMapping(
  items: readonly MappingItem[],
  options: {
    readonly categoryId?: string;
    readonly categoryLabel?: string;
    readonly sectionId?: string;
    readonly sectionLabel?: string;
  } = {},
): MappingData {
  const sectionId = options.sectionId ?? "main";
  const sectionLabel = options.sectionLabel ?? "Main";
  const categoryId = options.categoryId ?? "items";
  const categoryLabel = options.categoryLabel ?? "Items";

  return {
    version: "fixture-v1",
    sections: [
      {
        id: sectionId,
        label: sectionLabel,
        categories: [
          {
            id: categoryId,
            label: categoryLabel,
            items,
          },
        ],
      },
    ],
  };
}

function createEmptyMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [],
  };
}

function createParsedSave(
  decodedSave: DecodedSave,
  version: Partial<ParsedDecodedSave["version"]> = {},
): ParsedDecodedSave {
  return {
    decodedSave,
    version: {
      saveSchemaVersion: "fixture-save-schema-v1",
      ...version,
    },
  };
}

function sceneBoolItem(
  id: string,
  label: string,
  item: {
    readonly flag: string;
    readonly required?: number;
    readonly scene: string;
  },
): MappingItem {
  return {
    type: "sceneBool",
    id,
    label,
    ...item,
  };
}

function flagItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "flag",
    flag,
    id,
    label,
  };
}

function bossItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "boss",
    flag,
    id,
    label,
  };
}

function keyItem(
  id: string,
  label: string,
  key: { readonly flag: string } | { readonly flags: readonly string[] },
): MappingItem {
  return {
    type: "key",
    id,
    label,
    ...key,
  };
}

function levelItem(
  id: string,
  label: string,
  flag: string,
  required: number,
): MappingItem {
  return {
    type: "level",
    flag,
    id,
    label,
    required,
  };
}

function flagIntItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "flagInt",
    flag,
    id,
    label,
  };
}

function collectableItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "collectable",
    flag,
    id,
    label,
  };
}

function toolItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "tool",
    flag,
    id,
    label,
  };
}

function questItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "quest",
    flag,
    id,
    label,
  };
}

function journalItem(
  id: string,
  label: string,
  flag: string,
  required: number,
): MappingItem {
  return {
    type: "journal",
    flag,
    id,
    label,
    required,
  };
}

function relicItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "relic",
    flag,
    id,
    label,
  };
}

function materiumItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "materium",
    flag,
    id,
    label,
  };
}

function deviceItem(
  id: string,
  label: string,
  item: {
    readonly flag: string;
    readonly relatedFlag: string;
    readonly scene: string;
  },
): MappingItem {
  return {
    type: "device",
    id,
    label,
    ...item,
  };
}

function sceneVisitedItem(
  id: string,
  label: string,
  scene: string,
): MappingItem {
  return {
    type: "sceneVisited",
    id,
    label,
    scene,
  };
}

function quillItem(id: string, label: string, flag: string): MappingItem {
  return {
    type: "quill",
    flag,
    id,
    label,
  };
}

function assertSnapshotItem(
  snapshot: SemanticSnapshot,
  id: string,
  expected: {
    readonly sourceReferences?: readonly SourceReference[];
    readonly status: SemanticSnapshotItemStatus;
    readonly value?: unknown;
  },
) {
  const item = snapshot.items.find((candidate) => candidate.id === id);

  if (item === undefined) {
    assert.fail(`Expected snapshot item '${id}' to exist.`);
  }

  assert.equal(item.status, expected.status);

  if ("value" in expected) {
    assert.deepEqual(item.value, expected.value);
  }

  if (expected.sourceReferences !== undefined) {
    assert.deepEqual(item.sourceReferences, expected.sourceReferences);
  }
}
