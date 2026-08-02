import { createSignal, Show } from "solid-js";

import type {
  LocalHttpCheckpointResult,
  LocalHttpWatcherStatus,
} from "@silksong-git/repo-session/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import viewStyles from "../../ui/View.module.css";
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
  const [watchControlPending, setWatchControlPending] = createSignal(false);
  const [watchControlError, setWatchControlError] = createSignal<string>();
  const isReadOnly = () => {
    const connection = localHistory.connection();
    return (
      connection.kind === "connected"
      && connection.session.access === "readOnly"
    );
  };
  const status = () => {
    const connection = localHistory.connection();
    return connection.kind === "connected"
      ? connection.session.watcherStatus()
      : undefined;
  };
  const activeStatus = () => {
    const value = status();

    return value?.status === "running" || value?.status === "stopping"
      ? value
      : undefined;
  };
  const refreshWatcherStatus = async () => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return;
    }

    const nextStatus = await connection.session.client.getWatcher();
    localHistory.updateWatcherStatus(nextStatus);
    localHistory.reportRequestSuccess();
  };
  const controlWatcher = async (action: "start" | "stop") => {
    if (watchControlPending()) {
      return;
    }

    setWatchControlPending(true);
    setWatchControlError(undefined);
    try {
      try {
        if (action === "start") {
          await localHistory.startWatching();
        } else {
          await localHistory.stopWatching();
        }
      } catch (error) {
        // Desktop watcher control is independent from the authenticated Local HTTP reader session.
        // A rejected watcher lease must not make browsing stale or pause its polling.
        setWatchControlError(getWatchControlErrorMessage(error, action));
        return;
      }

      try {
        await refreshWatcherStatus();
      } catch (error) {
        localHistory.reportRequestFailure(error);
        setWatchControlError(getWatchControlErrorMessage(error, action));
      }
    } finally {
      setWatchControlPending(false);
    }
  };

  return (
    <section class={viewStyles["view"]} data-testid="watcher-view">
      <h2 class={viewStyles["heading"]}>Watcher</h2>
      <Show when={isReadOnly()}>
        <p>Archived · Read-only. Watching and checkpoints are unavailable.</p>
      </Show>
      <Show when={status()} fallback={<p>Watcher status unavailable.</p>}>
        {(value) => (
          <dl>
            <dt>Status</dt>
            <dd>{value().status}</dd>
            <dt>Observation revision</dt>
            <dd>{value().observationRevision}</dd>
            <Show when={activeStatus()}>
              {(active) => (
                <>
                  <dt>Activity</dt>
                  <dd>{active().activity}</dd>
                  <dt>Watched path</dt>
                  <dd>{active().watchedSavePath}</dd>
                  <dt>Capture Policy</dt>
                  <dd>
                    {active().capturePolicy.debounceWriteMs} ms debounce,{" "}
                    {active().capturePolicy.minCommitIntervalMs} ms minimum
                    interval
                  </dd>
                </>
              )}
            </Show>
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
      <Show when={!isReadOnly() && status()?.status === "inactive"}>
        <button
          class={buttonStyles["primary"]}
          type="button"
          disabled={watchControlPending()}
          onClick={() => {
            controlWatcher("start").catch((error: unknown) => {
              console.error("[watcher] Unexpected start failure:", error);
            });
          }}
        >
          {watchControlPending() ? "Starting watcher…" : "Start Watching"}
        </button>
      </Show>
      <Show when={!isReadOnly() && status()?.status === "running"}>
        <button
          class={buttonStyles["danger"]}
          type="button"
          disabled={watchControlPending()}
          onClick={() => {
            controlWatcher("stop").catch((error: unknown) => {
              console.error("[watcher] Unexpected stop failure:", error);
            });
          }}
        >
          {watchControlPending() ? "Stopping watcher…" : "Stop Watching"}
        </button>
      </Show>
      <Show when={watchControlError()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
      <Show when={!isReadOnly()}>
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
          <button
            class={buttonStyles["primary"]}
            type="submit"
            disabled={checkpointPending()}
          >
            {checkpointPending() ? "Creating checkpoint…" : "Create checkpoint"}
          </button>
        </form>
      </Show>
      <Show when={checkpointResult()}>
        {(result) => <p>{getCheckpointResultMessage(result())}</p>}
      </Show>
      <Show when={checkpointError()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
    </section>
  );
}

function getWatchControlErrorMessage(
  error: unknown,
  action: "start" | "stop",
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return action === "start"
    ? "Watching could not be started."
    : "Watching could not be stopped.";
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
