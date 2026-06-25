import { strict as assert } from "node:assert";
import test from "node:test";

import type { DecodedSave, MappingData, SemanticSnapshot } from "../index.ts";
import { createSemanticSnapshot } from "../index.ts";

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
    decodedSave,
    createSceneBoolMapping(),
  );
  const item = findSnapshotItem(snapshot, "mask-shard-2");

  assert.equal(item.status, "done");
  assert.equal(item.value, true);
  assert.deepEqual(item.sourceReferences, [
    {
      flag: "Heart Piece",
      kind: "sceneFlag",
      scene: "Crawl_02",
    },
  ]);
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
    decodedSave,
    createSceneBoolMapping(),
  );
  const item = findSnapshotItem(snapshot, "mask-shard-2");

  assert.equal(item.status, "missing");
  assert.equal(item.value, false);
  assert.deepEqual(item.sourceReferences, [
    {
      flag: "Heart Piece",
      kind: "sceneFlag",
      scene: "Crawl_02",
    },
  ]);
});

test("createSemanticSnapshot maps direct playerData booleans to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      defeatedBellBeast: true,
      defeatedMoorwing: false,
    },
  };

  const snapshot = createSemanticSnapshot(
    decodedSave,
    createDirectPlayerDataBooleanMapping(),
  );
  const defeatedBellBeast = findSnapshotItem(snapshot, "bell-beast");
  const defeatedMoorwing = findSnapshotItem(snapshot, "moorwing");

  assert.equal(defeatedBellBeast.status, "done");
  assert.equal(defeatedBellBeast.value, true);
  assert.deepEqual(defeatedBellBeast.sourceReferences, [
    {
      field: "defeatedBellBeast",
      kind: "playerData",
    },
  ]);
  assert.equal(defeatedMoorwing.status, "missing");
  assert.equal(defeatedMoorwing.value, false);
  assert.deepEqual(defeatedMoorwing.sourceReferences, [
    {
      field: "defeatedMoorwing",
      kind: "playerData",
    },
  ]);
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

  const snapshot = createSemanticSnapshot(decodedSave, createKeyMapping());
  const cityKey = findSnapshotItem(snapshot, "city-key");
  const simpleKey = findSnapshotItem(snapshot, "simple-key");
  const unusedKey = findSnapshotItem(snapshot, "unused-key");

  assert.equal(cityKey.status, "done");
  assert.equal(cityKey.value, true);
  assert.deepEqual(cityKey.sourceReferences, [
    {
      field: "hasCityKey",
      kind: "playerData",
    },
  ]);

  assert.equal(simpleKey.status, "done");
  assert.equal(simpleKey.value, true);
  assert.deepEqual(simpleKey.sourceReferences, [
    {
      field: "hasSimpleKeyA",
      kind: "playerData",
    },
    {
      field: "hasSimpleKeyB",
      kind: "playerData",
    },
  ]);

  assert.equal(unusedKey.status, "missing");
  assert.equal(unusedKey.value, false);
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
    decodedSave,
    createNumericThresholdMapping(),
  );
  const baseNeedle = findSnapshotItem(snapshot, "base-needle");
  const shiningNeedle = findSnapshotItem(snapshot, "shining-needle");
  const hivesteelNeedle = findSnapshotItem(snapshot, "hivesteel-needle");
  const bellKey = findSnapshotItem(snapshot, "bell-key");
  const simpleKey = findSnapshotItem(snapshot, "simple-key-count");

  assert.equal(baseNeedle.status, "done");
  assert.equal(baseNeedle.value, 2);
  assert.equal(shiningNeedle.status, "done");
  assert.equal(shiningNeedle.value, 2);
  assert.equal(hivesteelNeedle.status, "missing");
  assert.equal(hivesteelNeedle.value, 2);
  assert.deepEqual(hivesteelNeedle.sourceReferences, [
    {
      field: "nailUpgrades",
      kind: "playerData",
    },
  ]);

  assert.equal(bellKey.status, "done");
  assert.equal(bellKey.value, true);
  assert.equal(simpleKey.status, "missing");
  assert.equal(simpleKey.value, false);
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
    decodedSave,
    createSavedDataMapping(),
  );
  const mossberry = findSnapshotItem(snapshot, "mossberry");
  const memoryLocket = findSnapshotItem(snapshot, "memory-locket");
  const straightPin = findSnapshotItem(snapshot, "straight-pin");
  const compass = findSnapshotItem(snapshot, "compass");

  assert.equal(mossberry.status, "done");
  assert.equal(mossberry.value, 2);
  assert.deepEqual(mossberry.sourceReferences, [
    {
      field: "Collectables",
      kind: "savedData",
      name: "Mossberry",
    },
  ]);

  assert.equal(memoryLocket.status, "missing");
  assert.equal(memoryLocket.value, 0);
  assert.equal(straightPin.status, "done");
  assert.equal(straightPin.value, true);
  assert.deepEqual(straightPin.sourceReferences, [
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
  ]);
  assert.equal(compass.status, "missing");
  assert.equal(compass.value, false);
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

  const snapshot = createSemanticSnapshot(decodedSave, createQuestMapping());
  const citadelSeeker = findSnapshotItem(snapshot, "citadel-seeker");
  const lostMerchant = findSnapshotItem(snapshot, "lost-merchant");
  const quietWish = findSnapshotItem(snapshot, "quiet-wish");

  assert.equal(citadelSeeker.status, "accepted");
  assert.equal(citadelSeeker.value, "accepted");
  assert.deepEqual(citadelSeeker.sourceReferences, [
    {
      field: "QuestCompletionData",
      kind: "savedData",
      name: "Citadel   Seeker",
    },
  ]);

  assert.equal(lostMerchant.status, "done");
  assert.equal(lostMerchant.value, "completed");
  assert.equal(quietWish.status, "missing");
  assert.equal(quietWish.value, false);
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

  const snapshot = createSemanticSnapshot(decodedSave, createJournalMapping());
  const mossCharger = findSnapshotItem(snapshot, "moss-charger");
  const bellBeast = findSnapshotItem(snapshot, "bell-beast-journal");
  const missingEntry = findSnapshotItem(snapshot, "missing-entry");

  assert.equal(mossCharger.status, "accepted");
  assert.equal(mossCharger.value, 2);
  assert.deepEqual(mossCharger.sourceReferences, [
    {
      field: "EnemyJournalKillData",
      kind: "playerData",
    },
  ]);

  assert.equal(bellBeast.status, "done");
  assert.equal(bellBeast.value, 5);
  assert.equal(missingEntry.status, "missing");
  assert.equal(missingEntry.value, 0);
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
    decodedSave,
    createRelicMateriumDeviceMapping(),
  );
  const depositedRelic = findSnapshotItem(snapshot, "choral-commandment");
  const collectedRelic = findSnapshotItem(snapshot, "rune-harp");
  const collectedMaterium = findSnapshotItem(snapshot, "far-fields-materium");
  const depositedMaterium = findSnapshotItem(snapshot, "deposited-materium");
  const collectedDevice = findSnapshotItem(snapshot, "collected-device");
  const depositedDevice = findSnapshotItem(snapshot, "deposited-device");

  assert.equal(depositedRelic.status, "done");
  assert.equal(depositedRelic.value, "deposited");
  assert.equal(collectedRelic.status, "accepted");
  assert.equal(collectedRelic.value, "collected");
  assert.equal(collectedMaterium.status, "accepted");
  assert.equal(collectedMaterium.value, "collected");
  assert.equal(depositedMaterium.status, "done");
  assert.equal(depositedMaterium.value, "deposited");
  assert.equal(collectedDevice.status, "accepted");
  assert.equal(collectedDevice.value, "collected");
  assert.deepEqual(collectedDevice.sourceReferences, [
    {
      field: "otherDepositedDevice",
      kind: "playerData",
    },
    {
      kind: "sceneFlag",
      flag: "Device Pickup",
      scene: "Device_Room",
    },
  ]);
  assert.equal(depositedDevice.status, "done");
  assert.equal(depositedDevice.value, "deposited");
});

test("createSemanticSnapshot maps sceneVisited entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      scenesVisited: ["Crawl_02", "Dock_08"],
    },
  };

  const snapshot = createSemanticSnapshot(
    decodedSave,
    createSceneVisitedMapping(),
  );
  const visitedScene = findSnapshotItem(snapshot, "crawl-02");
  const unvisitedScene = findSnapshotItem(snapshot, "song-09");

  assert.equal(visitedScene.status, "done");
  assert.equal(visitedScene.value, true);
  assert.deepEqual(visitedScene.sourceReferences, [
    {
      field: "scenesVisited",
      kind: "playerData",
    },
  ]);

  assert.equal(unvisitedScene.status, "missing");
  assert.equal(unvisitedScene.value, false);
});

test("createSemanticSnapshot maps quill entries to semantic item status", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      hasQuill: true,
      QuillState: 2,
    },
  };

  const snapshot = createSemanticSnapshot(decodedSave, createQuillMapping());
  const activeQuillEntry = findSnapshotItem(snapshot, "QuillState_2");
  const inactiveQuillEntry = findSnapshotItem(snapshot, "QuillState_3");

  assert.equal(activeQuillEntry.status, "done");
  assert.equal(activeQuillEntry.value, 2);
  assert.deepEqual(activeQuillEntry.sourceReferences, [
    {
      field: "hasQuill",
      kind: "playerData",
    },
    {
      field: "QuillState",
      kind: "playerData",
    },
  ]);

  assert.equal(inactiveQuillEntry.status, "missing");
  assert.equal(inactiveQuillEntry.value, 2);
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

  const snapshot = createSemanticSnapshot(decodedSave, createAnyOfMapping());
  const toolPouch = findSnapshotItem(snapshot, "tool-pouch-2");
  const missingUpgrade = findSnapshotItem(snapshot, "missing-upgrade");

  assert.equal(toolPouch.status, "done");
  assert.deepEqual(toolPouch.value, [0, true]);
  assert.deepEqual(toolPouch.sourceReferences, [
    {
      field: "pinGalleriesCompleted",
      kind: "playerData",
    },
    {
      kind: "sceneFlag",
      flag: "Ladybug Craft Pickup",
      scene: "Bone_12",
    },
  ]);

  assert.equal(missingUpgrade.status, "missing");
  assert.deepEqual(missingUpgrade.value, [0, false]);
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
    decodedSave,
    createShellFossilMimicMapping(),
  );
  const visibleMimic = findSnapshotItem(snapshot, "visible-mimic");
  const wrongMimicVariant = findSnapshotItem(snapshot, "wrong-mimic-variant");
  const missingMimic = findSnapshotItem(snapshot, "missing-mimic");

  assert.equal(visibleMimic.status, "done");
  assert.equal(visibleMimic.value, true);
  assert.equal(wrongMimicVariant.status, "missing");
  assert.equal(wrongMimicVariant.value, false);
  assert.equal(missingMimic.status, "missing");
  assert.equal(missingMimic.value, false);
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

  const snapshot = createSemanticSnapshot(decodedSave, createEmptyMapping());

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

  const snapshot = createSemanticSnapshot(decodedSave, createEmptyMapping(), {
    configHash: "config-hash",
    gameVersion: "1.0.30000",
    platform: "steam",
    platformBuildId: "22479045",
    saveSchemaVersion: "silksong-save-v1",
    semanticCoreVersion: "test-core",
  });

  assert.deepEqual(snapshot.version, {
    configHash: "config-hash",
    gameVersion: "1.0.30000",
    mappingDataVersion: "fixture-v1",
    platform: "steam",
    platformBuildId: "22479045",
    saveSchemaVersion: "silksong-save-v1",
    semanticCoreVersion: "test-core",
  });
});

function createSceneBoolMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "main",
        label: "Main",
        categories: [
          {
            id: "mask-shards",
            label: "Mask Shards",
            items: [
              {
                type: "sceneBool",
                flag: "Heart Piece",
                scene: "Crawl_02",
                id: "mask-shard-2",
                label: "Mask Shard #2",
              },
            ],
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

function createDirectPlayerDataBooleanMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "bosses",
        label: "Bosses",
        categories: [
          {
            id: "bosses",
            label: "Bosses",
            items: [
              {
                type: "flag",
                flag: "defeatedBellBeast",
                id: "bell-beast",
                label: "Bell Beast",
              },
              {
                type: "boss",
                flag: "defeatedMoorwing",
                id: "moorwing",
                label: "Moorwing",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createKeyMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "essentials",
        label: "Essentials",
        categories: [
          {
            id: "keys",
            label: "Keys",
            items: [
              {
                type: "key",
                flag: "hasCityKey",
                id: "city-key",
                label: "City Key",
              },
              {
                type: "key",
                flags: ["hasSimpleKeyA", "hasSimpleKeyB"],
                id: "simple-key",
                label: "Simple Key",
              },
              {
                type: "key",
                flag: "hasUnusedKey",
                id: "unused-key",
                label: "Unused Key",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createNumericThresholdMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "main",
        label: "Main",
        categories: [
          {
            id: "needle-upgrades",
            label: "Needle Upgrades",
            items: [
              {
                type: "level",
                flag: "nailUpgrades",
                id: "base-needle",
                label: "Base Needle",
                required: 0,
              },
              {
                type: "level",
                flag: "nailUpgrades",
                id: "shining-needle",
                label: "Shining Needle",
                required: 2,
              },
              {
                type: "level",
                flag: "nailUpgrades",
                id: "hivesteel-needle",
                label: "Hivesteel Needle",
                required: 3,
              },
              {
                type: "flagInt",
                flag: "bellKeyCount",
                id: "bell-key",
                label: "Bell Key",
              },
              {
                type: "flagInt",
                flag: "simpleKeyCount",
                id: "simple-key-count",
                label: "Simple Key Count",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createSavedDataMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "main",
        label: "Main",
        categories: [
          {
            id: "items",
            label: "Items",
            items: [
              {
                type: "collectable",
                flag: "Mossberry",
                id: "mossberry",
                label: "Mossberry",
              },
              {
                type: "collectable",
                flag: "Memory Locket",
                id: "memory-locket",
                label: "Memory Locket",
              },
              {
                type: "tool",
                flag: "Straight Pin",
                id: "straight-pin",
                label: "Straight Pin",
              },
              {
                type: "tool",
                flag: "Compass",
                id: "compass",
                label: "Compass",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createQuestMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "wishes",
        label: "Wishes",
        categories: [
          {
            id: "wishes",
            label: "Wishes",
            items: [
              {
                type: "quest",
                flag: "Citadel   Seeker",
                id: "citadel-seeker",
                label: "Citadel Seeker",
              },
              {
                type: "quest",
                flag: "Lost Merchant",
                id: "lost-merchant",
                label: "Lost Merchant",
              },
              {
                type: "quest",
                flag: "Quiet Wish",
                id: "quiet-wish",
                label: "Quiet Wish",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createJournalMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "journal",
        label: "Journal",
        categories: [
          {
            id: "journal",
            label: "Journal",
            items: [
              {
                type: "journal",
                flag: "Moss Charger",
                id: "moss-charger",
                label: "Moss Charger",
                required: 5,
              },
              {
                type: "journal",
                flag: "Bell Beast",
                id: "bell-beast-journal",
                label: "Bell Beast",
                required: 5,
              },
              {
                type: "journal",
                flag: "Missing Entry",
                id: "missing-entry",
                label: "Missing Entry",
                required: 1,
              },
            ],
          },
        ],
      },
    ],
  };
}

function createRelicMateriumDeviceMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "completion",
        label: "Completion",
        categories: [
          {
            id: "relics",
            label: "Relics",
            items: [
              {
                type: "relic",
                flag: "Choral Commandment",
                id: "choral-commandment",
                label: "Choral Commandment",
              },
              {
                type: "relic",
                flag: "Rune Harp",
                id: "rune-harp",
                label: "Rune Harp",
              },
              {
                type: "materium",
                flag: "Far Fields Materium",
                id: "far-fields-materium",
                label: "Far Fields Materium",
              },
              {
                type: "materium",
                flag: "Deposited Materium",
                id: "deposited-materium",
                label: "Deposited Materium",
              },
              {
                type: "device",
                flag: "Device Pickup",
                id: "collected-device",
                label: "Collected Device",
                relatedFlag: "otherDepositedDevice",
                scene: "Device_Room",
              },
              {
                type: "device",
                flag: "Missing Device Pickup",
                id: "deposited-device",
                label: "Deposited Device",
                relatedFlag: "depositedDevice",
                scene: "Device_Room",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createSceneVisitedMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "scenes",
        label: "Scenes",
        categories: [
          {
            id: "scenes",
            label: "Scenes",
            items: [
              {
                type: "sceneVisited",
                id: "crawl-02",
                label: "Crawl 02",
                scene: "Crawl_02",
              },
              {
                type: "sceneVisited",
                id: "song-09",
                label: "Song 09",
                scene: "Song_09",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createQuillMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "main",
        label: "Main",
        categories: [
          {
            id: "quill",
            label: "Quill",
            items: [
              {
                type: "quill",
                flag: "QuillState",
                id: "QuillState_2",
                label: "Quill Entry 2",
              },
              {
                type: "quill",
                flag: "QuillState",
                id: "QuillState_3",
                label: "Quill Entry 3",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createAnyOfMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "main",
        label: "Main",
        categories: [
          {
            id: "tool-pouch",
            label: "Tool Pouch",
            items: [
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
          },
        ],
      },
    ],
  };
}

function createShellFossilMimicMapping(): MappingData {
  return {
    version: "fixture-v1",
    sections: [
      {
        id: "completion",
        label: "Completion",
        categories: [
          {
            id: "special",
            label: "Special",
            items: [
              {
                type: "sceneBool",
                flag: "Shell Fossil Mimic",
                id: "visible-mimic",
                label: "Visible Mimic",
                required: 2,
                scene: "Fossil_Room",
              },
              {
                type: "sceneBool",
                flag: "Shell Fossil Mimic",
                id: "wrong-mimic-variant",
                label: "Wrong Mimic Variant",
                required: 3,
                scene: "Fossil_Room",
              },
              {
                type: "sceneBool",
                flag: "Shell Fossil Mimic AppearVariant",
                id: "missing-mimic",
                label: "Missing Mimic",
                required: 1,
                scene: "Fossil_Room",
              },
            ],
          },
        ],
      },
    ],
  };
}

function findSnapshotItem(snapshot: SemanticSnapshot, id: string) {
  const item = snapshot.items.find((candidate) => candidate.id === id);

  assert.ok(item, `Expected snapshot item '${id}' to exist.`);

  return item;
}
