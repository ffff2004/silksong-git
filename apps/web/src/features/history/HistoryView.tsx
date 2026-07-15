import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalHistoryClientError } from "../local-history/local-history-client.ts";
import { LocalRoute } from "../local-history/LocalRoute.tsx";
import type { HistoryEventFilters } from "./history-events-query.ts";
import { createHistoryEventsQuery } from "./history-events-query.ts";
import { createHistoryObservationsQuery } from "./history-observations-query.ts";
import { HistoryCommitCard } from "./HistoryCommitCard.tsx";

const eventTypes = [
  "itemStatusChanged",
  "itemValueChanged",
  "summaryMetricChanged",
] as const;
const targetStatuses = ["accepted", "done", "missing", "unknown"] as const;
const eventDirections = ["neutral", "progression", "regression"] as const;

export function HistoryRoute() {
  return (
    <LocalRoute>
      <HistoryView />
    </LocalRoute>
  );
}

function HistoryView() {
  const localHistory = useLocalHistoryStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [view, setView] = createSignal<"events" | "observations">("events");
  const [text, setText] = createSignal("");
  const [eventType, setEventType] = createSignal("");
  const [statusTo, setStatusTo] = createSignal<
    "" | "accepted" | "done" | "missing" | "unknown"
  >("");
  const [direction, setDirection] = createSignal<
    "" | "neutral" | "progression" | "regression"
  >("");
  const [includeFiltered, setIncludeFiltered] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [restoreCommit, setRestoreCommit] = createSignal<string>();
  const eventsQuery = createHistoryEventsQuery(() => {
    const connection = localHistory.connection();
    return connection.kind === "connected"
      ? connection.session.client
      : undefined;
  });
  const observationsQuery = createHistoryObservationsQuery(() => {
    const connection = localHistory.connection();
    return connection.kind === "connected"
      ? connection.session.client
      : undefined;
  });
  let previousObservationRevision: number | undefined;

  createEffect(() => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      previousObservationRevision = undefined;
      return;
    }

    const nextRevision = connection.session.observationRevision();
    if (nextRevision === undefined) {
      return;
    }
    if (previousObservationRevision === undefined) {
      previousObservationRevision = nextRevision;
      return;
    }
    if (nextRevision === previousObservationRevision) {
      return;
    }
    previousObservationRevision = nextRevision;
    if (eventsQuery.hasLoaded()) {
      eventsQuery.refresh().catch(handleUnexpectedLoadError);
    }
    if (observationsQuery.hasLoaded()) {
      observationsQuery.refresh().catch(handleUnexpectedLoadError);
    }
  });

  onMount(() => {
    const params = new URLSearchParams(location.search);
    setText(params.get("text") ?? "");
    setEventType(getEnumParam(params, "eventType", eventTypes));
    setStatusTo(getEnumParam(params, "statusTo", targetStatuses));
    setDirection(getEnumParam(params, "direction", eventDirections));
    setIncludeFiltered(params.get("includeFiltered") === "true");
    const initialView =
      params.get("view") === "observations" ? "observations" : "events";
    setView(initialView);
    if (initialView === "observations") {
      observationsQuery.load().catch(handleUnexpectedLoadError);
    } else {
      eventsQuery
        .submit(currentEventFilters())
        .catch(handleUnexpectedLoadError);
    }
  });

  function handleUnexpectedLoadError(error_: unknown) {
    setError(error_ instanceof Error ? error_.message : "History unavailable.");
  }

  function currentEventFilters(): HistoryEventFilters {
    const query = text().trim();
    const selectedEventType = eventType();
    const selectedStatus = statusTo();
    const selectedDirection = direction();
    return {
      direction: selectedDirection === "" ? undefined : selectedDirection,
      eventType: selectedEventType === "" ? undefined : selectedEventType,
      includeFiltered: includeFiltered() ? true : undefined,
      statusTo: selectedStatus === "" ? undefined : selectedStatus,
      text: query === "" ? undefined : query,
    };
  }

  function selectCompareCommit(commit: string) {
    const params = new URLSearchParams(location.search);
    const compareFrom = params.get("compareFrom");
    if (compareFrom === null) {
      params.set("compareFrom", commit);
      navigate(`/history?${params.toString()}`);
      return;
    }

    navigate(
      `/diff?from=${encodeURIComponent(compareFrom)}&to=${encodeURIComponent(commit)}`,
    );
  }

  return (
    <section class="tab local-history-view" data-testid="history-view">
      <h2>History</h2>
      <div class="local-history-tabs" role="tablist" aria-label="History view">
        <button
          class="btn-reset"
          classList={{ active: view() === "events" }}
          type="button"
          role="tab"
          aria-selected={view() === "events"}
          onClick={() => {
            setView("events");
            const params = new URLSearchParams(location.search);
            params.set("view", "events");
            navigate(`/history?${params.toString()}`);
            if (!eventsQuery.hasLoaded()) {
              eventsQuery
                .submit(currentEventFilters())
                .catch(handleUnexpectedLoadError);
            }
          }}
        >
          Events
        </button>
        <button
          class="btn-reset"
          classList={{ active: view() === "observations" }}
          type="button"
          role="tab"
          aria-selected={view() === "observations"}
          onClick={() => {
            setView("observations");
            const params = new URLSearchParams(location.search);
            params.set("view", "observations");
            navigate(`/history?${params.toString()}`);
            if (!observationsQuery.hasLoaded()) {
              observationsQuery.load().catch(handleUnexpectedLoadError);
            }
          }}
        >
          Observations
        </button>
      </div>
      <form
        class="history-search"
        onSubmit={(event) => {
          event.preventDefault();
          const params = new URLSearchParams(location.search);
          params.set("view", "events");
          if (text().trim() === "") {
            params.delete("text");
          } else {
            params.set("text", text().trim());
          }
          setOptionalParam(params, "eventType", eventType());
          setOptionalParam(params, "statusTo", statusTo());
          setOptionalParam(params, "direction", direction());
          if (includeFiltered()) {
            params.set("includeFiltered", "true");
          } else {
            params.delete("includeFiltered");
          }
          navigate(`/history?${params.toString()}`);
          eventsQuery
            .submit(currentEventFilters())
            .catch(handleUnexpectedLoadError);
        }}
      >
        <label>
          Search events
          <input
            id="history-search-text"
            value={text()}
            onInput={(event) => {
              setText(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          Event kind
          <select
            id="history-search-event-kind"
            value={eventType()}
            onChange={(event) => {
              setEventType(event.currentTarget.value);
            }}
          >
            <option value="">Any event kind</option>
            <option value="itemStatusChanged">Item status changed</option>
            <option value="itemValueChanged">Item value changed</option>
            <option value="summaryMetricChanged">Summary changed</option>
          </select>
        </label>
        <label>
          Target status
          <select
            id="history-search-target-status"
            value={statusTo()}
            onChange={(event) => {
              setStatusTo(
                event.currentTarget.value as ReturnType<typeof statusTo>,
              );
            }}
          >
            <option value="">Any target status</option>
            <option value="accepted">Accepted</option>
            <option value="done">Done</option>
            <option value="missing">Missing</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label>
          Direction
          <select
            id="history-search-direction"
            value={direction()}
            onChange={(event) => {
              setDirection(
                event.currentTarget.value as ReturnType<typeof direction>,
              );
            }}
          >
            <option value="">Any direction</option>
            <option value="progression">Progression</option>
            <option value="regression">Regression</option>
            <option value="neutral">Neutral</option>
          </select>
        </label>
        <label>
          <input
            id="history-search-include-filtered"
            type="checkbox"
            checked={includeFiltered()}
            onChange={(event) => {
              setIncludeFiltered(event.currentTarget.checked);
            }}
          />
          Include filtered events
        </label>
        <button class="btn-primary" type="submit">
          Search
        </button>
      </form>
      <Show when={error() ?? eventsQuery.error() ?? observationsQuery.error()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
      <Show when={eventsQuery.isLoading() || observationsQuery.isLoading()}>
        <p>Loading history…</p>
      </Show>
      <Show when={view() === "events"}>
        <div data-testid="history-events">
          <Show
            when={eventsQuery.groups().length}
            fallback={<p>No events yet.</p>}
          >
            <For each={eventsQuery.groups()}>
              {(group) => (
                <HistoryCommitCard
                  record={{ group, kind: "events" }}
                  onCompare={selectCompareCommit}
                  onRestore={() => {
                    setRestoreCommit(group.commit.ref);
                  }}
                  onExport={() => {
                    exportCommit(localHistory, group.commit.ref).catch(
                      handleUnexpectedLoadError,
                    );
                  }}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={view() === "events" && eventsQuery.hasMore()}>
        <button
          class="btn-reset"
          type="button"
          disabled={eventsQuery.isLoading() || observationsQuery.isLoading()}
          onClick={() => {
            eventsQuery.loadMore().catch(handleUnexpectedLoadError);
          }}
        >
          Load More
        </button>
      </Show>
      <Show when={view() === "observations"}>
        <div data-testid="history-observations">
          <Show
            when={observationsQuery.entries().length}
            fallback={<p>No observations yet.</p>}
          >
            <For each={observationsQuery.entries()}>
              {(entry) => (
                <HistoryCommitCard
                  record={{ entry, kind: "observation" }}
                  onCompare={selectCompareCommit}
                  onRestore={() => {
                    setRestoreCommit(entry.observation.commit.ref);
                  }}
                  onExport={() => {
                    exportCommit(
                      localHistory,
                      entry.observation.commit.ref,
                    ).catch(handleUnexpectedLoadError);
                  }}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>
      <Show when={view() === "observations" && observationsQuery.hasMore()}>
        <button
          class="btn-reset"
          type="button"
          disabled={eventsQuery.isLoading() || observationsQuery.isLoading()}
          onClick={() => {
            observationsQuery.loadMore().catch(handleUnexpectedLoadError);
          }}
        >
          Load More
        </button>
      </Show>
      <Show when={restoreCommit()}>
        {(commit) => (
          <RestoreDialog
            commit={commit()}
            onClose={() => {
              setRestoreCommit(undefined);
            }}
          />
        )}
      </Show>
    </section>
  );
}

function setOptionalParam(
  params: URLSearchParams,
  name: string,
  value: string,
) {
  if (value === "") {
    params.delete(name);
  } else {
    params.set(name, value);
  }
}

function getEnumParam<T extends string>(
  params: URLSearchParams,
  name: string,
  values: readonly T[],
): "" | T {
  const value = params.get(name);
  return values.find((candidate) => candidate === value) ?? "";
}

async function exportCommit(
  localHistory: ReturnType<typeof useLocalHistoryStore>,
  commit: string,
) {
  const connection = localHistory.connection();
  if (connection.kind !== "connected") {
    return;
  }
  const download = await connection.session.client.exportSave(commit);
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([download.bytes]));
  anchor.download = download.fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function RestoreDialog(props: {
  readonly commit: string;
  readonly onClose: () => void;
}) {
  const localHistory = useLocalHistoryStore();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [requiresMissingConfirmation, setRequiresMissingConfirmation] =
    createSignal(false);
  const [message, setMessage] = createSignal<string>();

  const restore = async (confirmMissing = false) => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }
    setIsSubmitting(true);
    try {
      let expectedCurrent:
        | { readonly status: "present"; readonly encodedSha256: string }
        | { readonly status: "missing" };
      if (confirmMissing) {
        expectedCurrent = { status: "missing" };
      } else {
        const latest = await connection.session.client.getSave({
          kind: "latest",
        });
        if (latest.status === "empty") {
          setRequiresMissingConfirmation(true);
          setMessage(
            "The Watched Save is missing. Restoring it cannot create an original-file backup.",
          );
          return;
        }
        expectedCurrent = {
          encodedSha256: latest.observation.encodedSha256,
          status: "present",
        };
      }
      await connection.session.client.restoreInPlace({
        commitRef: props.commit,
        expectedCurrent,
      });
      setRequiresMissingConfirmation(false);
      setMessage("Restore completed. The watcher will observe the new save.");
    } catch (error) {
      setMessage(getRestoreErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      class="modal-overlay"
      data-testid="restore-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div class="modal-content">
        <h3>Restore {props.commit}?</h3>
        <p>This writes the selected Encoded Save to the Watched Save.</p>
        <Show when={message()}>{(value) => <p role="alert">{value()}</p>}</Show>
        <button class="btn-reset" type="button" onClick={props.onClose}>
          Cancel
        </button>
        <button
          class="btn-primary"
          type="button"
          disabled={isSubmitting()}
          onClick={() => {
            restore().catch((error_: unknown) => {
              setMessage(
                error_ instanceof Error ? error_.message : "Restore failed.",
              );
            });
          }}
        >
          {isSubmitting() ? "Restoring…" : "Confirm Restore"}
        </button>
        <Show when={requiresMissingConfirmation()}>
          <button
            class="btn-primary"
            type="button"
            disabled={isSubmitting()}
            onClick={() => {
              restore(true).catch((error_: unknown) => {
                setMessage(getRestoreErrorMessage(error_));
              });
            }}
          >
            Restore Missing Watched Save
          </button>
        </Show>
      </div>
    </div>
  );
}

function getRestoreErrorMessage(error: unknown): string {
  if (
    error instanceof LocalHistoryClientError
    && error.code === "restore_conflict"
  ) {
    return `${error.message} Wait for watcher synchronization or create a Manual Checkpoint before trying again.`;
  }

  return error instanceof Error ? error.message : "Restore failed.";
}
