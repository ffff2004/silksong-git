import { createSignal, Show } from "solid-js";

import type { OpenExternalRepositoryResult } from "../../runtime-capabilities/interface.ts";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import type { LocalHistoryClientError } from "./local-history-client.ts";
import styles from "./LocalConnectionControl.module.css";

interface LocalConnectionControlProps {
  readonly onConnected: () => void;
}

export function LocalConnectionControl(props: LocalConnectionControlProps) {
  const localHistory = useLocalHistoryStore();
  const [openingRepository, setOpeningRepository] = createSignal(false);
  const [canReconnect, setCanReconnect] = createSignal(false);
  const [repositorySelection, setRepositorySelection] =
    createSignal<OpenExternalRepositoryResult>();
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
  const actionRequiredSelection = () => {
    const selection = repositorySelection();

    return selection?.kind === "requiresAction" ? selection : undefined;
  };
  const openButtonLabel = () => {
    if (openingRepository()) {
      return "Opening…";
    }
    if (isConnecting()) {
      return "Connecting…";
    }

    return "Open Local History";
  };

  const connect = async () => {
    const connected = await localHistory.connect();
    if (connected) {
      setCanReconnect(true);
      props.onConnected();
    }
  };
  const openRepository = async () => {
    if (openingRepository() || isConnecting()) {
      return;
    }

    setOpeningRepository(true);
    setRepositorySelection(undefined);
    try {
      const selected = await localHistory.openExternalRepository();
      setRepositorySelection(selected);
      if (selected.kind !== "opened") {
        return;
      }

      // Rust replaced any prior Repo Session before reporting success. Drop the old in-memory HTTP
      // client only now, so a cancelled or incompatible selection preserves browsing.
      localHistory.disconnect();
      await connect();
    } finally {
      setOpeningRepository(false);
    }
  };

  return (
    <div class={styles["controls"]}>
      <Show
        when={localHistory.connection().kind === "connected"}
        fallback={
          <Show
            when={canReconnect()}
            fallback={
              <button
                class={`${buttonStyles["primary"]} ${buttonStyles["compact"]}`}
                id="connect-local-history"
                type="button"
                disabled={openingRepository() || isConnecting()}
                onClick={() => {
                  openRepository().catch((error: unknown) => {
                    console.error(
                      "[local-history] Unexpected repository selection error:",
                      error,
                    );
                  });
                }}
              >
                {openButtonLabel()}
              </button>
            }
          >
            <button
              class={`${buttonStyles["primary"]} ${buttonStyles["compact"]}`}
              id="connect-local-history"
              type="button"
              disabled={isConnecting()}
              onClick={() => {
                connect().catch((error: unknown) => {
                  console.error(
                    "[local-history] Unexpected reconnect error:",
                    error,
                  );
                });
              }}
            >
              {isConnecting() ? "Connecting…" : "Reconnect Local History"}
            </button>
          </Show>
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
          Disconnect WebView
        </button>
        <button
          class={`${buttonStyles["primary"]} ${buttonStyles["compact"]}`}
          id="open-another-local-history"
          type="button"
          disabled={openingRepository()}
          onClick={() => {
            openRepository().catch((error: unknown) => {
              console.error(
                "[local-history] Unexpected repository selection error:",
                error,
              );
            });
          }}
        >
          {openingRepository() ? "Opening…" : "Open another repository"}
        </button>
      </Show>
      <Show when={connectionError()}>
        {(error) => (
          <p class={styles["error"]} role="alert">
            {formatError(error())}
          </p>
        )}
      </Show>
      <Show when={actionRequiredSelection()}>
        {(selection) => (
          <p class={styles["error"]} role="alert">
            {formatRepositorySelection(selection())}
          </p>
        )}
      </Show>
    </div>
  );
}

function formatRepositorySelection(
  selection: Extract<OpenExternalRepositoryResult, { kind: "requiresAction" }>,
): string {
  switch (selection.action) {
    case "chooseAnotherDirectory": {
      return "This folder is not a compatible Save History Repository. Choose another directory.";
    }

    case "confirmMigration": {
      return "This repository needs a confirmed migration before it can be opened. Use the supported migration workflow, then try again.";
    }

    case "rebuildReadModel": {
      return "This repository needs its Semantic Read Model rebuilt before it can be opened. Rebuild it with a compatible current version, then try again.";
    }

    case "useNewerApp": {
      return "This repository was created by a newer incompatible app. Update Desktop before opening it.";
    }
  }
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
