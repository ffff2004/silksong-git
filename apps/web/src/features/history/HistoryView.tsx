import { useLocation, useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";

import type {
  LocalHttpHistoryResult,
  LocalHttpObservationHistoryResult,
} from "@silksong-git/history/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalRoute } from "../local-history/LocalRoute.tsx";

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
  const [history, setHistory] = createSignal<LocalHttpHistoryResult>();
  const [observations, setObservations] =
    createSignal<LocalHttpObservationHistoryResult>();
  const [text, setText] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [restoreCommit, setRestoreCommit] = createSignal<string>();

  onMount(() => {
    const params = new URLSearchParams(location.search);
    setText(params.get("text") ?? "");
    setView(params.get("view") === "observations" ? "observations" : "events");
    loadEvents().catch(handleUnexpectedLoadError);
  });

  function handleUnexpectedLoadError(error_: unknown) {
    setError(error_ instanceof Error ? error_.message : "History unavailable.");
  }

  async function loadEvents(
    input: {
      readonly append?: boolean;
      readonly cursor?: string;
    } = {},
  ) {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }

    setIsLoading(true);
    setError(undefined);
    try {
      const query = text().trim();
      const result =
        query === ""
          ? await connection.session.client.getHistory({ cursor: input.cursor })
          : await connection.session.client.search({
              text: query,
              cursor: input.cursor,
            });
      const current = history();
      setHistory(
        input.append === true && current !== undefined
          ? {
              events: [...current.events, ...result.events],
              nextCursor: result.nextCursor,
            }
          : result,
      );
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "History unavailable.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function loadObservations() {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }

    setIsLoading(true);
    setError(undefined);
    try {
      setObservations(await connection.session.client.getObservations());
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "History unavailable.",
      );
    } finally {
      setIsLoading(false);
    }
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
            const params = new URLSearchParams({ view: "events" });
            if (text() !== "") {
              params.set("text", text());
            }
            navigate(`/history?${params.toString()}`);
            if (history() === undefined) {
              loadEvents().catch(handleUnexpectedLoadError);
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
            navigate("/history?view=observations");
            if (observations() === undefined) {
              loadObservations().catch(handleUnexpectedLoadError);
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
          navigate(`/history?${params.toString()}`);
          loadEvents().catch(handleUnexpectedLoadError);
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
        <button class="btn-primary" type="submit">
          Search
        </button>
      </form>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={isLoading()}>
        <p>Loading history…</p>
      </Show>
      <Show when={view() === "events"}>
        <div data-testid="history-events">
          <Show
            when={history()?.events.length}
            fallback={<p>No events yet.</p>}
          >
            <For each={groupEvents(history()?.events ?? [])}>
              {(group) => (
                <HistoryCommitCard
                  group={group}
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
      <Show when={view() === "events" && history()?.nextCursor !== undefined}>
        <button
          class="btn-reset"
          type="button"
          disabled={isLoading()}
          onClick={() => {
            loadEvents({ append: true, cursor: history()?.nextCursor }).catch(
              handleUnexpectedLoadError,
            );
          }}
        >
          Load More
        </button>
      </Show>
      <Show when={!isLoading() && view() === "observations"}>
        <div data-testid="history-observations">
          <Show
            when={observations()?.entries.length}
            fallback={<p>No observations yet.</p>}
          >
            <For each={observations()?.entries}>
              {(entry) => (
                <article class="history-card">
                  <h3>{entry.observation.commit.shortRef}</h3>
                  <time>{entry.observation.observedAt}</time>
                  <p>
                    {entry.snapshotSummary
                      ? "Recognized schema"
                      : "Unrecognized schema"}
                  </p>
                </article>
              )}
            </For>
          </Show>
        </div>
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

type HistoryEvent = LocalHttpHistoryResult["events"][number];

interface HistoryGroup {
  readonly commit: HistoryEvent["commit"];
  readonly events: readonly HistoryEvent[];
}

function groupEvents(events: readonly HistoryEvent[]): readonly HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>();
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

function HistoryCommitCard(props: {
  readonly group: HistoryGroup;
  readonly onExport: () => void;
  readonly onRestore: () => void;
}) {
  const first = props.group.events[0];
  if (first === undefined) {
    return <></>;
  }

  return (
    <article class="history-card" data-testid="history-commit-card">
      <header>
        <strong>{props.group.commit.shortRef}</strong>
        <time>{props.group.commit.committedAt}</time>
      </header>
      <dl class="save-summary-metrics">
        <div>
          <dt>Completion</dt>
          <dd>{first.snapshotSummary.completionPercentage ?? 0}%</dd>
        </div>
        <div>
          <dt>Play Time</dt>
          <dd>{first.snapshotSummary.playTime ?? 0}</dd>
        </div>
        <div>
          <dt>Rosaries</dt>
          <dd>{first.snapshotSummary.rosaries ?? 0}</dd>
        </div>
        <div>
          <dt>Shell Shards</dt>
          <dd>{first.snapshotSummary.shellShards ?? 0}</dd>
        </div>
      </dl>
      <div class="history-actions">
        <a
          class="btn-primary"
          href={`/progress?commit=${encodeURIComponent(props.group.commit.ref)}`}
        >
          View Progress
        </a>
        <button class="btn-reset" type="button" onClick={props.onExport}>
          Export
        </button>
        <button class="btn-reset" type="button" onClick={props.onRestore}>
          Restore
        </button>
        <a
          class="btn-reset"
          href={`/diff?from=${encodeURIComponent(first.previousCommit?.ref ?? props.group.commit.ref)}&to=${encodeURIComponent(props.group.commit.ref)}`}
        >
          Compare
        </a>
      </div>
      <ul>
        <For each={props.group.events}>
          {(event) => (
            <li data-testid="history-event-row">
              {event.event.kind === "item"
                ? event.event.item.label
                : event.event.metric}
            </li>
          )}
        </For>
      </ul>
    </article>
  );
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
  const [message, setMessage] = createSignal<string>();

  const restore = async () => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }
    setIsSubmitting(true);
    try {
      const latest = await connection.session.client.getSave({
        kind: "latest",
      });
      const expectedCurrent =
        latest.status === "available"
          ? {
              encodedSha256: latest.observation.encodedSha256,
              status: "present" as const,
            }
          : { status: "missing" as const };
      await connection.session.client.restoreInPlace({
        commitRef: props.commit,
        expectedCurrent,
      });
      setMessage("Restore completed. The watcher will observe the new save.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Restore failed.");
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
      </div>
    </div>
  );
}
