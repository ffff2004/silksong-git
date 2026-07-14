import { createSignal, onMount, Show } from "solid-js";

import type { LocalHttpWatcherStatus } from "@silksong-git/history/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalRoute } from "../local-history/LocalRoute.tsx";

export function WatcherRoute() {
  return (
    <LocalRoute>
      <WatcherView />
    </LocalRoute>
  );
}

function WatcherView() {
  const localHistory = useLocalHistoryStore();
  const [status, setStatus] = createSignal<LocalHttpWatcherStatus>();
  const [error, setError] = createSignal<string>();

  onMount(() => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }
    connection.session.client
      .getWatcher()
      .then(setStatus)
      .catch((error_: unknown) => {
        setError(
          error_ instanceof Error ? error_.message : "Watcher unavailable.",
        );
      });
  });

  return (
    <section class="tab" data-testid="watcher-view">
      <h2>Watcher</h2>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={status()} fallback={<p>Watcher status unavailable.</p>}>
        {(value) => (
          <dl>
            <dt>Activity</dt>
            <dd>{value().activity}</dd>
            <dt>Observation revision</dt>
            <dd>{value().observationRevision}</dd>
            <dt>Watched path</dt>
            <dd>{value().watchedSavePath}</dd>
          </dl>
        )}
      </Show>
    </section>
  );
}
