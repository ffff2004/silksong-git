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

function findSnapshotItem(snapshot: SemanticSnapshot, id: string) {
  const item = snapshot.items.find((candidate) => candidate.id === id);

  assert.ok(item, `Expected snapshot item '${id}' to exist.`);

  return item;
}
