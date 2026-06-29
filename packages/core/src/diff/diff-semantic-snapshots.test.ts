import { strict as assert } from "node:assert";
import test from "node:test";

import type { SemanticSnapshot } from "../index.ts";
import { diffSemanticSnapshots } from "../index.ts";

test("diffSemanticSnapshots creates an item-level event when a scene item is collected", () => {
  const before = createSnapshot(sceneItem("missing", false));
  const after = createSnapshot(sceneItem("done", true));

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

test("diffSemanticSnapshots preserves quest accepted and completed states in item events", () => {
  const before = createSnapshot(questItem("accepted", "accepted"));
  const after = createSnapshot(questItem("done", "completed"));

  const events = diffSemanticSnapshots(before, after);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0]?.before, {
    status: "accepted",
    value: "accepted",
  });
  assert.deepEqual(events[0]?.after, {
    status: "done",
    value: "completed",
  });
  assert.equal(events[0]?.direction, "progression");
  assert.equal(events[0]?.item.id, "citadel-seeker");
  assert.equal(events[0]?.item.type, "quest");
});

function createSnapshot(item: SemanticSnapshot["items"][number]): SemanticSnapshot {
  return {
    items: [item],
    summary: {},
    version: {
      mappingDataVersion: "mapping-v1",
      saveSchemaVersion: "schema-v1",
      semanticCoreVersion: "core-v1",
    },
  };
}

function sceneItem(
  status: SemanticSnapshot["items"][number]["status"],
  value: unknown,
): SemanticSnapshot["items"][number] {
  return {
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
    status,
    type: "sceneBool",
    value,
  };
}

function questItem(
  status: SemanticSnapshot["items"][number]["status"],
  value: unknown,
): SemanticSnapshot["items"][number] {
  return {
    categoryId: "wishes",
    id: "citadel-seeker",
    label: "Citadel Seeker",
    sectionId: "wishes",
    sourceReferences: [
      {
        field: "QuestCompletionData",
        kind: "savedData",
        name: "Citadel Seeker",
      },
    ],
    status,
    type: "quest",
    value,
  };
}
