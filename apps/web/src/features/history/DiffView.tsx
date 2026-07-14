import { createSignal, onMount, Show } from "solid-js";

import type { LocalHttpDiffResult } from "@silksong-git/history/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalRoute } from "../local-history/LocalRoute.tsx";
import { ProgressSnapshotView } from "../progress/ProgressSnapshotView.tsx";
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
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const [diff, setDiff] = createSignal<LocalHttpDiffResult>();
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
      setDiff(
        await connection.session.client.getDiff({ from: from(), to: to() }),
      );
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
      <Show when={diff()}>
        {(value) => (
          <MonacoJsonViewer
            value={JSON.stringify(value().after, undefined, 2)}
          />
        )}
      </Show>
    </section>
  );
}
