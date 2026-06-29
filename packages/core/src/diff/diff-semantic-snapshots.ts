import type {
  SemanticEvent,
  SemanticEventDirection,
  SemanticItemEvent,
  SemanticSnapshot,
  SemanticSnapshotItemStatus,
  SemanticSnapshotItem,
} from "../types.ts";

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

  return events;
}

function shouldRecordValueChange(item: SemanticSnapshotItem): boolean {
  return item.type === "journal";
}

function createItemEvent(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
  beforeItem: SemanticSnapshotItem,
  afterItem: SemanticSnapshotItem,
  options: Pick<SemanticItemEvent, "direction" | "eventType">,
): SemanticItemEvent {
  return {
    after: {
      status: afterItem.status,
      value: afterItem.value,
    },
    before: {
      status: beforeItem.status,
      value: beforeItem.value,
    },
    direction: options.direction,
    eventType: options.eventType,
    isRegression: options.direction === "regression",
    item: {
      categoryId: afterItem.categoryId,
      id: afterItem.id,
      label: afterItem.label,
      sectionId: afterItem.sectionId,
      type: afterItem.type,
    },
    kind: "item",
    sourceReferences: afterItem.sourceReferences,
    version: {
      after: after.version,
      before: before.version,
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

  if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
    return (
      beforeValue.length === afterValue.length
      && beforeValue.every((value, index) => isSameValue(value, afterValue[index]))
    );
  }

  return false;
}
