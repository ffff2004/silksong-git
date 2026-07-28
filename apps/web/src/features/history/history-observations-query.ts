import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

import type { LocalHttpObservationHistoryResult } from "@silksong-git/repo-session/http-wire";
import type { LocalHistoryClient } from "../local-history/local-history-client.ts";

type ObservationEntry = LocalHttpObservationHistoryResult["entries"][number];

export interface HistoryObservationsQuery {
  readonly entries: Accessor<readonly ObservationEntry[]>;
  readonly error: Accessor<string | undefined>;
  readonly hasLoaded: Accessor<boolean>;
  readonly hasMore: Accessor<boolean>;
  readonly isLoading: Accessor<boolean>;
  readonly load: () => Promise<void>;
  readonly loadMore: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export function createHistoryObservationsQuery(
  getClient: () => LocalHistoryClient | undefined,
): HistoryObservationsQuery {
  const [result, setResult] = createSignal<LocalHttpObservationHistoryResult>();
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();

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
      const next = await client.getObservations({ cursor });
      const current = result();
      if (mode === "append" && current !== undefined) {
        setResult({
          entries: [...current.entries, ...next.entries],
          nextCursor: next.nextCursor,
        });
      } else if (mode === "refresh" && current !== undefined) {
        setResult(mergeRefreshedObservations(current, next));
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
    entries: () => result()?.entries ?? [],
    error,
    hasLoaded: () => result() !== undefined,
    hasMore: () => result()?.nextCursor !== undefined,
    isLoading,
    load: async () => {
      await request("replace");
    },
    loadMore: async () => {
      await request("append");
    },
    refresh: async () => {
      await request("refresh");
    },
  };
}

function mergeRefreshedObservations(
  current: LocalHttpObservationHistoryResult,
  refreshed: LocalHttpObservationHistoryResult,
): LocalHttpObservationHistoryResult {
  const existingRefs = new Set(
    current.entries.map((entry) => entry.observation.commit.ref),
  );
  return {
    entries: [
      ...refreshed.entries.filter(
        (entry) => !existingRefs.has(entry.observation.commit.ref),
      ),
      ...current.entries,
    ],
    nextCursor: current.nextCursor,
  };
}
