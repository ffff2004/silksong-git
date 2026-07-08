import type {
  HistoricalSemanticEvent,
  SemanticUpdateResult,
} from "@silksong-git/history";

type ItemEvent = Extract<
  HistoricalSemanticEvent["event"],
  { readonly kind: "item" }
>;

export function formatSemanticUpdate(update: SemanticUpdateResult): string {
  if (update.status === "notAvailable") {
    return `events: unavailable (${update.reason})\n`;
  }

  if (update.events.length === 0) {
    return "events: 0\n";
  }

  return `${[
    `events: ${update.eventCount}`,
    ...update.events.map((event) => `- ${formatSemanticEvent(event)}`),
  ].join("\n")}\n`;
}

function formatSemanticEvent(event: HistoricalSemanticEvent): string {
  const semanticEvent = event.event;

  switch (semanticEvent.kind) {
    case "item": {
      return `${semanticEvent.item.label}: ${formatItemEventState(
        semanticEvent.before,
        semanticEvent.eventType,
      )} -> ${formatItemEventState(semanticEvent.after, semanticEvent.eventType)}`;
    }

    case "summaryMetric": {
      return `${semanticEvent.metric}: ${formatValue(
        semanticEvent.beforeValue,
      )} -> ${formatValue(semanticEvent.afterValue)}`;
    }
  }
}

export function formatHistoricalSemanticEventLine(
  event: HistoricalSemanticEvent,
): string {
  return `${event.commit.shortRef} ${formatSemanticEvent(event)}`;
}

function formatItemEventState(
  state: ItemEvent["before"],
  eventType: ItemEvent["eventType"],
): string {
  if (eventType === "itemStatusChanged") {
    return state.status;
  }

  if (state.value === undefined || state.value === null) {
    return state.status;
  }

  return `${state.status} (${formatValue(state.value)})`;
}

function formatValue(value: unknown): string {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}
