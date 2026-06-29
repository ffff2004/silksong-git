import type {
  SemanticEvent,
  SemanticEventDirection,
  SemanticSnapshot,
  SemanticSnapshotItemStatus,
} from "../types.ts";

export function diffSemanticSnapshots(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
): readonly SemanticEvent[] {
  const beforeItems = new Map(before.items.map((item) => [item.id, item]));
  const events: SemanticEvent[] = [];

  for (const afterItem of after.items) {
    const beforeItem = beforeItems.get(afterItem.id);

    if (beforeItem === undefined || beforeItem.status === afterItem.status) {
      continue;
    }

    const direction = getStatusDirection(beforeItem.status, afterItem.status);

    events.push({
      after: {
        status: afterItem.status,
        value: afterItem.value,
      },
      before: {
        status: beforeItem.status,
        value: beforeItem.value,
      },
      direction,
      eventType: "itemStatusChanged",
      isRegression: direction === "regression",
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
    });
  }

  return events;
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
