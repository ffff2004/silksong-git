import type {
  SaveSummaryMetricName,
  SemanticEvent,
  SemanticEventDirection,
  SemanticItemEvent,
  SemanticSnapshot,
  SemanticSnapshotItem,
  SemanticSnapshotItemStatus,
  SemanticSummaryMetricEvent,
  SourceReference,
} from "../types.ts";

import { isArray } from "complete-common";

const SUMMARY_METRIC_SOURCE_FIELDS: ReadonlyMap<SaveSummaryMetricName, string> =
  new Map<SaveSummaryMetricName, string>([
    ["completionPercentage", "completionPercentage"],
    ["permadeathMode", "permadeathMode"],
    ["playTime", "playTime"],
    ["rosaries", "geo"],
    ["shellShards", "ShellShards"],
  ]);

const SUMMARY_METRIC_ORDER = [
  "completionPercentage",
  "playTime",
  "rosaries",
  "shellShards",
  "permadeathMode",
] as const satisfies readonly SaveSummaryMetricName[];

export function diffSemanticSnapshots(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
): readonly SemanticEvent[] {
  const beforeItems = new Map(before.items.map((item) => [item.id, item]));
  const events: SemanticEvent[] = [];

  for (const afterItem of after.items) {
    const beforeItem = beforeItems.get(afterItem.id);

    if (beforeItem === undefined) {
      continue;
    }

    if (beforeItem.status !== afterItem.status) {
      events.push(
        createItemEvent(before, after, beforeItem, afterItem, {
          direction: getStatusDirection(beforeItem.status, afterItem.status),
          eventType: "itemStatusChanged",
        }),
      );
      continue;
    }

    if (
      shouldRecordValueChange(afterItem)
      && !isSameValue(beforeItem.value, afterItem.value)
    ) {
      events.push(
        createItemEvent(before, after, beforeItem, afterItem, {
          direction: getValueDirection(beforeItem.value, afterItem.value),
          eventType: "itemValueChanged",
        }),
      );
    }
  }

  events.push(...createSummaryMetricEvents(before, after));

  return events;
}

function shouldRecordValueChange(item: SemanticSnapshotItem): boolean {
  return item.type === "journal";
}

function createSummaryMetricEvents(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
): readonly SemanticSummaryMetricEvent[] {
  const events: SemanticSummaryMetricEvent[] = [];

  for (const metric of SUMMARY_METRIC_ORDER) {
    const beforeValue = before.summary[metric];
    const afterValue = after.summary[metric];

    if (isSameValue(beforeValue, afterValue)) {
      continue;
    }

    const direction = getValueDirection(beforeValue, afterValue);

    events.push({
      kind: "summaryMetric",
      eventType: "summaryMetricChanged",
      metric,
      beforeValue,
      afterValue,
      direction,
      isRegression: direction === "regression",
      sourceReferences: createSummaryMetricSourceReferences(metric),
      version: {
        before: before.version,
        after: after.version,
      },
    });
  }

  return events;
}

function createSummaryMetricSourceReferences(
  metric: SaveSummaryMetricName,
): readonly SourceReference[] {
  return [
    {
      field: getSummaryMetricSourceField(metric),
      kind: "playerData",
    },
  ];
}

function getSummaryMetricSourceField(metric: SaveSummaryMetricName): string {
  const field = SUMMARY_METRIC_SOURCE_FIELDS.get(metric);
  if (field === undefined) {
    throw new Error(`Unknown summary metric: ${metric}`);
  }

  return field;
}

function createItemEvent(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
  beforeItem: SemanticSnapshotItem,
  afterItem: SemanticSnapshotItem,
  options: Pick<SemanticItemEvent, "direction" | "eventType">,
): SemanticItemEvent {
  return {
    kind: "item",
    eventType: options.eventType,
    item: {
      id: afterItem.id,
      label: afterItem.label,
      sectionId: afterItem.sectionId,
      type: afterItem.type,
    },
    before: {
      status: beforeItem.status,
      value: beforeItem.value,
    },
    after: {
      status: afterItem.status,
      value: afterItem.value,
    },
    direction: options.direction,
    isRegression: options.direction === "regression",
    sourceReferences: afterItem.sourceReferences,
    version: {
      before: before.version,
      after: after.version,
    },
  };
}

function getStatusDirection(
  before: SemanticSnapshotItemStatus,
  after: SemanticSnapshotItemStatus,
): SemanticEventDirection {
  const beforeRank = getStatusRank(before);
  const afterRank = getStatusRank(after);

  if (afterRank > beforeRank) {
    return "progression";
  }

  if (afterRank < beforeRank) {
    return "regression";
  }

  return "neutral";
}

function getStatusRank(status: SemanticSnapshotItemStatus): number {
  switch (status) {
    case "missing": {
      return 0;
    }

    case "accepted": {
      return 1;
    }

    case "done": {
      return 2;
    }

    case "unknown": {
      return 0;
    }
  }
}

function getValueDirection(
  beforeValue: unknown,
  afterValue: unknown,
): SemanticEventDirection {
  if (typeof beforeValue !== "number" || typeof afterValue !== "number") {
    return "neutral";
  }

  if (afterValue > beforeValue) {
    return "progression";
  }

  if (afterValue < beforeValue) {
    return "regression";
  }

  return "neutral";
}

function isSameValue(beforeValue: unknown, afterValue: unknown): boolean {
  if (Object.is(beforeValue, afterValue)) {
    return true;
  }

  if (isArray(beforeValue) && isArray(afterValue)) {
    return (
      beforeValue.length === afterValue.length
      && beforeValue.every((value, index) =>
        isSameValue(value, afterValue[index]),
      )
    );
  }

  return false;
}
