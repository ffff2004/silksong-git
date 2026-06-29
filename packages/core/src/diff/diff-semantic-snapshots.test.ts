import { strict as assert } from "node:assert";
import test from "node:test";

import { isArray } from "complete-common";

import type {
  SemanticEvent,
  SemanticItemEvent,
  SemanticSnapshot,
  SemanticSnapshotItem,
} from "../index.ts";
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
  const event = onlyItemEvent(events);

  assert.deepEqual(event.before, {
    status: "accepted",
    value: "accepted",
  });
  assert.deepEqual(event.after, {
    status: "done",
    value: "completed",
  });
  assert.equal(event.direction, "progression");
  assert.equal(event.item.id, "citadel-seeker");
  assert.equal(event.item.type, "quest");
});

test("diffSemanticSnapshots creates one item event for each crossed numeric stage threshold", () => {
  const before = createSnapshot([
    levelItem("base-needle", "Base Needle", "done", 1),
    levelItem("sharpened-needle", "Sharpened Needle", "done", 1),
    levelItem("shining-needle", "Shining Needle", "missing", 1),
    levelItem("hivesteel-needle", "Hivesteel Needle", "missing", 1),
  ]);
  const after = createSnapshot([
    levelItem("base-needle", "Base Needle", "done", 3),
    levelItem("sharpened-needle", "Sharpened Needle", "done", 3),
    levelItem("shining-needle", "Shining Needle", "done", 3),
    levelItem("hivesteel-needle", "Hivesteel Needle", "done", 3),
  ]);

  const events = diffSemanticSnapshots(before, after);

  assert.deepEqual(
    itemEvents(events).map((event) => ({
      after: event.after,
      before: event.before,
      direction: event.direction,
      itemId: event.item.id,
    })),
    [
      {
        after: {
          status: "done",
          value: 3,
        },
        before: {
          status: "missing",
          value: 1,
        },
        direction: "progression",
        itemId: "shining-needle",
      },
      {
        after: {
          status: "done",
          value: 3,
        },
        before: {
          status: "missing",
          value: 1,
        },
        direction: "progression",
        itemId: "hivesteel-needle",
      },
    ],
  );
});

test("diffSemanticSnapshots records journal partial progress and completion threshold changes", () => {
  const before = createSnapshot([
    journalItem("moss-charger", "Moss Charger", "accepted", 2),
    journalItem("bell-beast", "Bell Beast", "accepted", 4),
  ]);
  const after = createSnapshot([
    journalItem("moss-charger", "Moss Charger", "accepted", 3),
    journalItem("bell-beast", "Bell Beast", "done", 5),
  ]);

  const events = diffSemanticSnapshots(before, after);

  assert.deepEqual(
    itemEvents(events).map((event) => ({
      after: event.after,
      before: event.before,
      eventType: event.eventType,
      itemId: event.item.id,
    })),
    [
      {
        after: {
          status: "accepted",
          value: 3,
        },
        before: {
          status: "accepted",
          value: 2,
        },
        eventType: "itemValueChanged",
        itemId: "moss-charger",
      },
      {
        after: {
          status: "done",
          value: 5,
        },
        before: {
          status: "accepted",
          value: 4,
        },
        eventType: "itemStatusChanged",
        itemId: "bell-beast",
      },
    ],
  );
});

test("diffSemanticSnapshots records save summary metric changes as semantic events", () => {
  const before = createSnapshot(sceneItem("missing", false), {
    completionPercentage: 12,
    rosaries: 120,
  });
  const after = createSnapshot(sceneItem("missing", false), {
    completionPercentage: 13,
    rosaries: 145,
  });

  const events = diffSemanticSnapshots(before, after);

  assert.deepEqual(events, [
    {
      afterValue: 13,
      beforeValue: 12,
      direction: "progression",
      eventType: "summaryMetricChanged",
      isRegression: false,
      kind: "summaryMetric",
      metric: "completionPercentage",
      sourceReferences: [
        {
          field: "completionPercentage",
          kind: "playerData",
        },
      ],
      version: {
        after: after.version,
        before: before.version,
      },
    },
    {
      afterValue: 145,
      beforeValue: 120,
      direction: "progression",
      eventType: "summaryMetricChanged",
      isRegression: false,
      kind: "summaryMetric",
      metric: "rosaries",
      sourceReferences: [
        {
          field: "geo",
          kind: "playerData",
        },
      ],
      version: {
        after: after.version,
        before: before.version,
      },
    },
  ]);
});

test("diffSemanticSnapshots marks backward item and numeric transitions as regression events", () => {
  const before = createSnapshot([
    sceneItem("done", true),
    journalItem("moss-charger", "Moss Charger", "accepted", 4),
  ]);
  const after = createSnapshot([
    sceneItem("missing", false),
    journalItem("moss-charger", "Moss Charger", "accepted", 2),
  ]);

  const events = diffSemanticSnapshots(before, after);

  assert.deepEqual(
    events.map((event) => ({
      direction: event.direction,
      eventType: event.eventType,
      isRegression: event.isRegression,
      kind: event.kind,
    })),
    [
      {
        direction: "regression",
        eventType: "itemStatusChanged",
        isRegression: true,
        kind: "item",
      },
      {
        direction: "regression",
        eventType: "itemValueChanged",
        isRegression: true,
        kind: "item",
      },
    ],
  );
});

function onlyItemEvent(events: readonly SemanticEvent[]): SemanticItemEvent {
  const itemEventList = itemEvents(events);

  assert.equal(itemEventList.length, 1);

  const itemEvent = itemEventList[0];

  if (itemEvent === undefined) {
    assert.fail("expected one item event");
  }

  return itemEvent;
}

function itemEvents(
  events: readonly SemanticEvent[],
): readonly SemanticItemEvent[] {
  const itemEventList = events.filter((event) => event.kind === "item");

  assert.equal(itemEventList.length, events.length);

  return itemEventList;
}

function createSnapshot(
  items: SemanticSnapshotItem | readonly SemanticSnapshotItem[],
  summary: SemanticSnapshot["summary"] = {},
): SemanticSnapshot {
  return {
    items: isSnapshotItemArray(items) ? items : [items],
    summary,
    version: {
      saveSchemaVersion: "schema-v1",
      mappingDataVersion: "mapping-v1",
      semanticCoreVersion: "core-v1",
    },
  };
}

function isSnapshotItemArray(
  value: SemanticSnapshotItem | readonly SemanticSnapshotItem[],
): value is readonly SemanticSnapshotItem[] {
  return isArray(value);
}

function sceneItem(
  status: SemanticSnapshot["items"][number]["status"],
  value: unknown,
): SemanticSnapshot["items"][number] {
  return {
    id: "mask-shard-2",
    label: "Mask Shard #2",
    sectionId: "main",
    categoryId: "items",
    type: "sceneBool",
    status,
    value,
    sourceReferences: [
      {
        flag: "Heart Piece",
        kind: "sceneFlag",
        scene: "Crawl_02",
      },
    ],
  };
}

function questItem(
  status: SemanticSnapshot["items"][number]["status"],
  value: unknown,
): SemanticSnapshot["items"][number] {
  return {
    id: "citadel-seeker",
    label: "Citadel Seeker",
    sectionId: "wishes",
    categoryId: "wishes",
    type: "quest",
    status,
    value,
    sourceReferences: [
      {
        field: "QuestCompletionData",
        kind: "savedData",
        name: "Citadel Seeker",
      },
    ],
  };
}

function levelItem(
  id: string,
  label: string,
  status: SemanticSnapshot["items"][number]["status"],
  value: number,
): SemanticSnapshot["items"][number] {
  return {
    id,
    label,
    sectionId: "main",
    categoryId: "needle-upgrades",
    type: "level",
    status,
    value,
    sourceReferences: [
      {
        field: "nailUpgrades",
        kind: "playerData",
      },
    ],
  };
}

function journalItem(
  id: string,
  label: string,
  status: SemanticSnapshot["items"][number]["status"],
  value: number,
): SemanticSnapshot["items"][number] {
  return {
    id,
    label,
    sectionId: "journal",
    categoryId: "journal",
    type: "journal",
    status,
    value,
    sourceReferences: [
      {
        field: "EnemyJournalKillData",
        kind: "savedData",
        name: label,
      },
    ],
  };
}
