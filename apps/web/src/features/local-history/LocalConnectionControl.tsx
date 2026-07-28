import { Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import type { LocalHistoryClientError } from "./local-history-client.ts";
import styles from "./LocalConnectionControl.module.css";

interface LocalConnectionControlProps {
  readonly onConnected: () => void;
}

export function LocalConnectionControl(props: LocalConnectionControlProps) {
  const localHistory = useLocalHistoryStore();
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

  const connect = async () => {
    const connected = await localHistory.connect();
    if (connected) {
      props.onConnected();
    }
  };

  return (
    <div class={styles["controls"]}>
      <Show
        when={localHistory.connection().kind === "connected"}
        fallback={
          <button
            class={`${buttonStyles["primary"]} ${buttonStyles["compact"]}`}
            id="connect-local-history"
            type="button"
            disabled={isConnecting()}
            onClick={() => {
              connect().catch((error: unknown) => {
                console.error(
                  "[local-history] Unexpected connection error:",
                  error,
                );
              });
            }}
          >
            {isConnecting() ? "Connecting…" : "Connect to Local History"}
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
          class={buttonStyles["danger"]}
          id="disconnect-local-history"
          type="button"
          onClick={() => {
            localHistory.disconnect();
          }}
        >
          Disconnect Local History
        </button>
      </Show>
      <Show when={connectionError()}>
        {(error) => (
          <p class={styles["error"]} role="alert">
            {formatError(error())}
          </p>
        )}
      </Show>
    </div>
  );
}

function formatError(error: LocalHistoryClientError): string {
  if (error.kind === "unauthorized") {
    return "The Desktop session credentials are invalid or expired. Reopen the Desktop session, then reconnect.";
  }
  if (error.kind === "local-network-denied") {
    return "Local Network Access was denied. Allow this site to access the local network, then try again.";
  }
  if (error.kind === "unavailable") {
    return "The Local History endpoint is unavailable.";
  }
  if (error.kind === "protocol") {
    return "The Local History endpoint returned an invalid response.";
  }

  return error.message;
}
