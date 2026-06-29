import { strict as assert } from "node:assert";
import test from "node:test";

import type { SemanticSnapshot } from "../index.ts";
import { diffSemanticSnapshots } from "../index.ts";

test("diffSemanticSnapshots creates an item-level event when a scene item is collected", () => {
  const before = createSnapshot({
    status: "missing",
    value: false,
  });
  const after = createSnapshot({
    status: "done",
    value: true,
  });

  const events = diffSemanticSnapshots(before, after);

  assert.deepEqual(events, [
    {
      after: {
        status: "done",
        value: true,
      },
      before: {
        status: "missing",
        value: false,
      },
      direction: "progression",
      eventType: "itemStatusChanged",
      isRegression: false,
      item: {
        categoryId: "items",
        id: "mask-shard-2",
        label: "Mask Shard #2",
        sectionId: "main",
        type: "sceneBool",
      },
      kind: "item",
      sourceReferences: [
        {
          flag: "Heart Piece",
          kind: "sceneFlag",
          scene: "Crawl_02",
        },
      ],
      version: {
        after: {
          mappingDataVersion: "mapping-v1",
          saveSchemaVersion: "schema-v1",
          semanticCoreVersion: "core-v1",
        },
        before: {
          mappingDataVersion: "mapping-v1",
          saveSchemaVersion: "schema-v1",
          semanticCoreVersion: "core-v1",
        },
      },
    },
  ]);
});

function createSnapshot(
  itemState: Pick<SemanticSnapshot["items"][number], "status" | "value">,
): SemanticSnapshot {
  return {
    items: [
      {
        categoryId: "items",
        id: "mask-shard-2",
        label: "Mask Shard #2",
        sectionId: "main",
        sourceReferences: [
          {
            flag: "Heart Piece",
            kind: "sceneFlag",
            scene: "Crawl_02",
          },
        ],
        type: "sceneBool",
        ...itemState,
      },
    ],
    summary: {},
    version: {
      mappingDataVersion: "mapping-v1",
      saveSchemaVersion: "schema-v1",
      semanticCoreVersion: "core-v1",
    },
  };
}
