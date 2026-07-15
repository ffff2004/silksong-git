import { Show, createSignal } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import type { LocalHistoryClientError } from "./local-history-client.ts";
import styles from "./LocalConnectionDialog.module.css";

interface LocalConnectionDialogProps {
  readonly onConnected: () => void;
}

export function LocalConnectionDialog(props: LocalConnectionDialogProps) {
  const localHistory = useLocalHistoryStore();
  const [isOpen, setIsOpen] = createSignal(false);
  const [endpoint, setEndpoint] = createSignal("http://127.0.0.1:4312");
  const [token, setToken] = createSignal("");

  const isConnecting = () => localHistory.connection().kind === "connecting";
  const connectionError = () => {
    const connection = localHistory.connection();

    return connection.kind === "error" ? connection.error : undefined;
  };
  const connectedAvailability = () => {
    const connection = localHistory.connection();

    return connection.kind === "connected"
      ? connection.availability
      : undefined;
  };
  const staleAvailability = () => {
    const availability = connectedAvailability();

    return availability?.kind === "stale" ? availability : undefined;
  };

  const close = () => {
    if (!isConnecting()) {
      setIsOpen(false);
    }
  };

  const connect = async (event: SubmitEvent) => {
    event.preventDefault();
    const connected = await localHistory.connect({
      endpoint: endpoint(),
      token: token(),
    });
    if (connected) {
      setIsOpen(false);
      props.onConnected();
    }
  };

  return (
    <div class={styles["controls"]}>
      <Show
        when={localHistory.connection().kind === "connected"}
        fallback={
          <button
            class="btn-primary"
            id="connect-local-history"
            type="button"
            onClick={() => {
              setIsOpen(true);
            }}
          >
            Connect to Local History
          </button>
        }
      >
        <span
          class={styles["status"]}
          classList={{ [styles["stale"]!]: staleAvailability() !== undefined }}
          role={staleAvailability() === undefined ? undefined : "alert"}
          title={staleAvailability()?.error.message}
        >
          {staleAvailability() === undefined
            ? "Local History connected"
            : "Local History stale"}
        </span>
        <button
          class="btn-reset"
          id="disconnect-local-history"
          type="button"
          onClick={() => {
            localHistory.disconnect();
          }}
        >
          Disconnect Local History
        </button>
      </Show>

      <Show when={isOpen()}>
        <div
          class={styles["overlay"]}
          role="dialog"
          aria-modal="true"
          aria-labelledby="local-history-dialog-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
        >
          <form
            class={styles["dialog"]}
            onSubmit={(event) => {
              connect(event).catch((error: unknown) => {
                console.error(
                  "[local-history] Unexpected connection error:",
                  error,
                );
              });
            }}
          >
            <div class={styles["header"]}>
              <h2 id="local-history-dialog-title">Connect to Local History</h2>
              <button
                class={styles["close"]}
                type="button"
                aria-label="Close"
                onClick={close}
              >
                X
              </button>
            </div>
            <label class={styles["field"]}>
              Endpoint
              <input
                id="local-history-endpoint"
                type="url"
                value={endpoint()}
                required
                autocomplete="url"
                onInput={(event) => {
                  setEndpoint(event.currentTarget.value);
                }}
              />
            </label>
            <label class={styles["field"]}>
              Bearer token
              <input
                id="local-history-token"
                type="password"
                value={token()}
                required
                autocomplete="off"
                onInput={(event) => {
                  setToken(event.currentTarget.value);
                }}
              />
            </label>
            <p class={styles["help"]}>
              Credentials stay in this page session only.
            </p>
            <Show when={connectionError()}>
              {(error) => (
                <p class={styles["error"]} role="alert">
                  {formatError(error())}
                </p>
              )}
            </Show>
            <div class={styles["actions"]}>
              <button class="btn-reset" type="button" onClick={close}>
                Cancel
              </button>
              <button
                class="btn-primary"
                id="local-history-connect"
                type="submit"
                disabled={isConnecting()}
              >
                {isConnecting() ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        </div>
      </Show>
    </div>
  );
}

function formatError(error: LocalHistoryClientError): string {
  if (error.kind === "unauthorized") {
    return "Authentication failed. Check the bearer token.";
  }
  if (error.kind === "incompatible") {
    return "The Local History API is not compatible with this Web UI.";
  }
  if (error.kind === "unavailable") {
    return "The Local History endpoint is unavailable.";
  }
  if (error.kind === "protocol") {
    return "The Local History endpoint returned an invalid response.";
  }

  return error.message;
}
