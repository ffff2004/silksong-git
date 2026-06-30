import type { SemanticEvent } from "@silksong-git/core";

import type { readProjectConfig } from "../config.ts";
import type { HistoricalSemanticEvent } from "../types.ts";

type DisplaySemanticEventFilters = Awaited<
  ReturnType<typeof readProjectConfig>
>["displaySemanticEventFilters"];

export function applyDisplayFilters(
  events: readonly HistoricalSemanticEvent[],
  includeFiltered: boolean | undefined,
): readonly HistoricalSemanticEvent[] {
  return events.filter(
    (event) => includeFiltered === true || event.visibility.defaultVisible,
  );
}

export function getEventVisibility(
  event: SemanticEvent,
  filters: DisplaySemanticEventFilters,
): HistoricalSemanticEvent["visibility"] {
  const filterReasons: string[] = [];

  if (filters.hideEventTypes.includes(event.eventType)) {
    filterReasons.push(`eventType:${event.eventType}`);
  }

  if (
    event.kind === "item"
    && filters.hideItemTypes.includes(event.item.type)
  ) {
    filterReasons.push(`itemType:${event.item.type}`);
  }

  if (
    event.kind === "summaryMetric"
    && filters.hideSummaryMetrics.includes(event.metric)
  ) {
    filterReasons.push(`summaryMetric:${event.metric}`);
  }

  return {
    defaultVisible: filterReasons.length === 0,
    filterReasons,
  };
}
