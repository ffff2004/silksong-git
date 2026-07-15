import { useNavigate } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";

import type { LocalHttpDiffResult } from "@silksong-git/history/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalRoute } from "../local-history/LocalRoute.tsx";
import { ProgressSnapshotView } from "../progress/ProgressSnapshotView.tsx";
import { MonacoJsonDiffViewer } from "../raw-save/MonacoJsonDiffViewer.tsx";
import { MonacoJsonViewer } from "../raw-save/MonacoJsonViewer.tsx";

export function DiffRoute() {
  return (
    <LocalRoute>
      <DiffView />
    </LocalRoute>
  );
}

function DiffView() {
  const localHistory = useLocalHistoryStore();
  const navigate = useNavigate();
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const [view, setView] = createSignal<"raw" | "semantic">("semantic");
  const [diff, setDiff] = createSignal<LocalHttpDiffResult>();
  const [rawDiff, setRawDiff] = createSignal<{
    readonly fromValue: string;
    readonly toValue: string;
  }>();
  const [error, setError] = createSignal<string>();

  onMount(() => {
    const params = new URLSearchParams(
      globalThis.location.hash.split("?", 2)[1] ?? "",
    );
    setFrom(params.get("from") ?? "");
    setTo(params.get("to") ?? "");
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const connection = localHistory.connection();
    if (connection.kind !== "connected" || from() === "" || to() === "") {
      return;
    }
    try {
      const fromRef = from();
      const toRef = to();
      navigate(
        `/diff?from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`,
      );
      const nextDiff = await connection.session.client.getDiff({
        from: fromRef,
        to: toRef,
      });
      setDiff(nextDiff);

      const [fromSave, toSave] = await Promise.all([
        connection.session.client.getSave({
          commitRef: fromRef,
          kind: "commit",
        }),
        connection.session.client.getSave({
          commitRef: toRef,
          kind: "commit",
        }),
      ]);
      if (fromSave.status !== "available" || toSave.status !== "available") {
        throw new Error("Decoded Save JSON is unavailable for this diff.");
      }
      setRawDiff({
        fromValue: stringifyDecodedSave(fromSave.decodedSave),
        toValue: stringifyDecodedSave(toSave.decodedSave),
      });
      setError(undefined);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : "Diff unavailable.");
    }
  };

  const handleSubmit = (event: SubmitEvent) => {
    submit(event).catch((error_: unknown) => {
      setError(error_ instanceof Error ? error_.message : "Diff unavailable.");
    });
  };

  return (
    <section class="tab" data-testid="diff-view">
      <h2>Compare Saves</h2>
      <form onSubmit={handleSubmit}>
        <label>
          From{" "}
          <input
            id="diff-from"
            value={from()}
            onInput={(event) => {
              setFrom(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            id="diff-to"
            value={to()}
            onInput={(event) => {
              setTo(event.currentTarget.value);
            }}
          />
        </label>
        <button class="btn-primary" type="submit">
          Compare
        </button>
      </form>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={diff()}>
        <div class="local-history-tabs" role="tablist" aria-label="Diff view">
          <button
            class="btn-reset"
            classList={{ active: view() === "semantic" }}
            type="button"
            role="tab"
            aria-selected={view() === "semantic"}
            onClick={() => {
              setView("semantic");
            }}
          >
            Semantic
          </button>
          <button
            class="btn-reset"
            classList={{ active: view() === "raw" }}
            type="button"
            role="tab"
            aria-selected={view() === "raw"}
            onClick={() => {
              setView("raw");
            }}
          >
            Raw JSON
          </button>
        </div>
        <Show when={view() === "semantic"}>
          <Show when={diff()}>
            {(value) => (
              <ProgressSnapshotView
                presentation={{
                  before: value().before,
                  events: value().events.map((entry) => entry.event),
                  kind: "comparison",
                }}
                snapshot={value().after}
              />
            )}
          </Show>
        </Show>
        <Show when={view() === "raw"}>
          <Show when={diff()}>
            {(value) => (
              <Show
                fallback={
                  <MonacoJsonViewer
                    value={JSON.stringify(value().after, undefined, 2)}
                  />
                }
                when={rawDiff()}
              >
                {(rawValue) => (
                  <MonacoJsonDiffViewer
                    fromValue={rawValue().fromValue}
                    toValue={rawValue().toValue}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function stringifyDecodedSave(decodedSave: unknown): string {
  return JSON.stringify(decodedSave, undefined, 2);
}
