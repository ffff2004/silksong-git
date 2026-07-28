import type { Accessor } from "solid-js";
import { createMemo, createSignal } from "solid-js";

import type { LocalHttpHistoryResult } from "@silksong-git/repo-session/http-wire";
import type { LocalHistoryClient } from "../local-history/local-history-client.ts";

type HistoryEvent = LocalHttpHistoryResult["events"][number];

export interface HistoryEventFilters {
  readonly direction?: "neutral" | "progression" | "regression";
  readonly eventType?: string;
  readonly includeFiltered?: boolean;
  readonly statusTo?: "accepted" | "done" | "missing" | "unknown";
  readonly text?: string;
}

export interface HistoryEventGroup {
  readonly commit: HistoryEvent["commit"];
  readonly events: readonly HistoryEvent[];
}

export interface HistoryEventsQuery {
  readonly error: Accessor<string | undefined>;
  readonly groups: Accessor<readonly HistoryEventGroup[]>;
  readonly hasLoaded: Accessor<boolean>;
  readonly hasMore: Accessor<boolean>;
  readonly isLoading: Accessor<boolean>;
  readonly loadMore: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly submit: (filters: HistoryEventFilters) => Promise<void>;
}

export function createHistoryEventsQuery(
  getClient: () => LocalHistoryClient | undefined,
): HistoryEventsQuery {
  const [result, setResult] = createSignal<LocalHttpHistoryResult>();
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let submittedFilters: HistoryEventFilters = {};

  const request = async (mode: "append" | "refresh" | "replace") => {
    const client = getClient();
    if (client === undefined) {
      return;
    }

    const cursor = mode === "append" ? result()?.nextCursor : undefined;
    if (mode === "append" && cursor === undefined) {
      return;
    }

    setIsLoading(true);
    setError(undefined);
    try {
      const hasSearchFields =
        submittedFilters.text !== undefined
        || submittedFilters.eventType !== undefined
        || submittedFilters.statusTo !== undefined
        || submittedFilters.direction !== undefined;
      const next = hasSearchFields
        ? await client.search({ ...submittedFilters, cursor })
        : await client.getHistory({
            cursor,
            includeFiltered: submittedFilters.includeFiltered,
          });
      const current = result();
      if (mode === "append" && current !== undefined) {
        setResult({
          events: [...current.events, ...next.events],
          nextCursor: next.nextCursor,
        });
      } else if (mode === "refresh" && current !== undefined) {
        setResult(mergeRefreshedEvents(current, next));
      } else {
        setResult(next);
      }
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "History unavailable.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return {
    error,
    groups: createMemo(() => groupEvents(result()?.events ?? [])),
    hasLoaded: () => result() !== undefined,
    hasMore: () => result()?.nextCursor !== undefined,
    isLoading,
    loadMore: async () => {
      await request("append");
    },
    refresh: async () => {
      await request("refresh");
    },
    submit: async (filters) => {
      submittedFilters = { ...filters };
      await request("replace");
    },
  };
}

function mergeRefreshedEvents(
  current: LocalHttpHistoryResult,
  refreshed: LocalHttpHistoryResult,
): LocalHttpHistoryResult {
  const existingIds = new Set(current.events.map((event) => event.id));
  return {
    events: [
      ...refreshed.events.filter((event) => !existingIds.has(event.id)),
      ...current.events,
    ],
    nextCursor: current.nextCursor,
  };
}

function groupEvents(
  events: readonly HistoryEvent[],
): readonly HistoryEventGroup[] {
  const groups = new Map<string, HistoryEventGroup>();
  for (const event of events) {
    const existing = groups.get(event.commit.ref);
    if (existing === undefined) {
      groups.set(event.commit.ref, { commit: event.commit, events: [event] });
    } else {
      groups.set(event.commit.ref, {
        commit: existing.commit,
        events: [...existing.events, event],
      });
    }
  }

  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- this keeps the grouping result readable and works on all supported browsers.
  return [...groups.values()];
}
