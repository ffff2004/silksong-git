import { strict as assert } from "node:assert";
import test from "node:test";

import type { DecodedSave, MappingData } from "../index.ts";
import { createSemanticSnapshot } from "../index.ts";

test("createSemanticSnapshot marks a scene-scoped collected item as done", () => {
  const decodedSave: DecodedSave = {
    playerData: {
      completionPercentage: 12,
      geo: 34,
      playTime: 56,
      ShellShards: 7,
    },
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

  const mappingData: MappingData = {
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

  const snapshot = createSemanticSnapshot(decodedSave, mappingData, {
    configHash: "config-hash",
    gameVersion: "1.0.30000",
    platform: "steam",
    platformBuildId: "22479045",
    saveSchemaVersion: "silksong-save-v1",
    semanticCoreVersion: "test-core",
  });

  const item = snapshot.items.find(({ id }) => id === "mask-shard-2");

  assert.equal(item?.status, "done");
  assert.equal(item.value, true);
  assert.deepEqual(item.sourceReferences, [
    {
      flag: "Heart Piece",
      kind: "sceneFlag",
      scene: "Crawl_02",
    },
  ]);
  assert.equal(snapshot.summary.completionPercentage, 12);
  assert.equal(snapshot.summary.playTime, 56);
  assert.equal(snapshot.summary.rosaries, 34);
  assert.equal(snapshot.summary.shellShards, 7);
  assert.equal("geo" in snapshot.summary, false);
  assert.equal("ShellShards" in snapshot.summary, false);
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

  const mappingData: MappingData = {
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

  const snapshot = createSemanticSnapshot(decodedSave, mappingData);
  const item = snapshot.items.find(({ id }) => id === "mask-shard-2");

  assert.equal(item?.status, "missing");
  assert.equal(item.value, false);
  assert.deepEqual(item.sourceReferences, [
    {
      flag: "Heart Piece",
      kind: "sceneFlag",
      scene: "Crawl_02",
    },
  ]);
});
