import { Show } from "solid-js";

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
  const status = () => {
    const connection = localHistory.connection();
    return connection.kind === "connected"
      ? connection.session.watcherStatus()
      : undefined;
  };

  return (
    <section class="tab" data-testid="watcher-view">
      <h2>Watcher</h2>
      <Show when={status()} fallback={<p>Watcher status unavailable.</p>}>
        {(value) => (
          <dl>
            <dt>Activity</dt>
            <dd>{value().activity}</dd>
            <dt>Observation revision</dt>
            <dd>{value().observationRevision}</dd>
            <dt>Watched path</dt>
            <dd>{value().watchedSavePath}</dd>
            <dt>Capture Policy</dt>
            <dd>
              {value().capturePolicy.debounceWriteMs} ms debounce,{" "}
              {value().capturePolicy.minCommitIntervalMs} ms minimum interval
            </dd>
            <Show when={value().lastObservation}>
              {(observation) => (
                <>
                  <dt>Latest observation</dt>
                  <dd>{observation().completedAt}</dd>
                  <dt>Result</dt>
                  <dd>{observation().status}</dd>
                  <Show when={getWatcherErrorMessage(observation())}>
                    {(message) => (
                      <>
                        <dt>Watcher Error</dt>
                        <dd role="alert">{message()}</dd>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </dl>
        )}
      </Show>
    </section>
  );
}

function getWatcherErrorMessage(
  observation: NonNullable<LocalHttpWatcherStatus["lastObservation"]>,
): string | undefined {
  return observation.status === "watcherError"
    ? observation.error.message
    : undefined;
}
