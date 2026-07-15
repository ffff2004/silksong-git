import { createSignal, Show } from "solid-js";

import type {
  LocalHttpCheckpointResult,
  LocalHttpWatcherStatus,
} from "@silksong-git/history/http-wire";
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
  const [checkpointMessage, setCheckpointMessage] = createSignal("");
  const [allowUnchanged, setAllowUnchanged] = createSignal(false);
  const [checkpointPending, setCheckpointPending] = createSignal(false);
  const [checkpointResult, setCheckpointResult] =
    createSignal<LocalHttpCheckpointResult>();
  const [checkpointError, setCheckpointError] = createSignal<string>();
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (checkpointPending()) {
            return;
          }
          const connection = localHistory.connection();
          if (connection.kind !== "connected") {
            return;
          }

          const message = checkpointMessage().trim();
          setCheckpointPending(true);
          setCheckpointResult(undefined);
          setCheckpointError(undefined);
          connection.session.client
            .checkpoint({
              ...(message !== "" && { message }),
              ...(allowUnchanged() && { allowUnchanged: true }),
            })
            .then(setCheckpointResult)
            .catch((error: unknown) => {
              localHistory.reportRequestFailure(error);
              setCheckpointError(
                error instanceof Error
                  ? error.message
                  : "Manual Checkpoint failed.",
              );
            })
            .finally(() => {
              setCheckpointPending(false);
            });
        }}
      >
        <label for="checkpoint-message">Checkpoint message (optional)</label>
        <input
          id="checkpoint-message"
          type="text"
          value={checkpointMessage()}
          onInput={(event) => {
            setCheckpointMessage(event.currentTarget.value);
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={allowUnchanged()}
            onChange={(event) => {
              setAllowUnchanged(event.currentTarget.checked);
            }}
          />
          Allow unchanged save
        </label>
        <button type="submit" disabled={checkpointPending()}>
          {checkpointPending() ? "Creating checkpoint…" : "Create checkpoint"}
        </button>
      </form>
      <Show when={checkpointResult()}>
        {(result) => <p>{getCheckpointResultMessage(result())}</p>}
      </Show>
      <Show when={checkpointError()}>
        {(message) => <p role="alert">{message()}</p>}
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

function getCheckpointResultMessage(result: LocalHttpCheckpointResult): string {
  switch (result.status) {
    case "committed": {
      return `Checkpoint committed as ${result.observation.commit.shortRef}.`;
    }

    case "skipped": {
      return `Checkpoint skipped: ${result.reason}.`;
    }

    case "watcherError": {
      return result.error.message;
    }
  }
}
