import { useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";

import type {
  OpenExternalRepositoryResult,
  RepositoryLibrary,
  RepositoryLibraryEntry,
} from "../../runtime-capabilities/interface.ts";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { useRuntimeCapabilities } from "../../state/runtime-capabilities.tsx";
import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import viewStyles from "../../ui/View.module.css";
import { applyStaticSaveResult } from "../current-save/static-save-result.ts";

export function RepositoryLibraryView() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const localHistory = useLocalHistoryStore();
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const navigate = useNavigate();
  const [library, setLibrary] = createSignal<RepositoryLibrary>();
  const [loading, setLoading] = createSignal(true);
  const [opening, setOpening] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [showArchives, setShowArchives] = createSignal(false);
  const [reopening, setReopening] = createSignal(false);
  const invalidatedWorkflow = () => {
    const state = localHistory.workflowState();
    return state.kind === "invalidated" ? state : undefined;
  };
  const connectionError = () => {
    const connection = localHistory.connection();
    if (connection.kind !== "error") {
      return undefined;
    }

    switch (connection.error.kind) {
      case "local-network-denied": {
        return "Local Network Access was denied. Allow this site to access the local network, then try again.";
      }

      case "unauthorized": {
        return "The Desktop session credentials are invalid or expired. Reopen the Desktop session, then reconnect.";
      }

      default: {
        return connection.error.message;
      }
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const nextLibrary = await localHistory.repositoryLibrary();
      setLibrary(nextLibrary);
      if (
        nextLibrary.external !== undefined
        && nextLibrary.external.current
        && localHistory.connection().kind === "disconnected"
        && saveStore.source().kind !== "static"
      ) {
        saveStore.clear();
        if (await localHistory.connect()) {
          navigate("/progress");
        }
      }
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not refresh repositories.",
      );
    } finally {
      setLoading(false);
    }
  };

  const open = async (entry: RepositoryLibraryEntry) => {
    if (entry.current || opening() !== undefined) {
      return;
    }
    setOpening(`${entry.lifecycle}:${entry.name}`);
    setError(undefined);
    try {
      const result = await localHistory.openLibraryEntry({
        lifecycle: entry.lifecycle === "archived" ? "archived" : "managed",
        name: entry.name,
      });
      if (result.kind !== "opened") {
        setError(formatOpenResult(result));
        return;
      }
      localHistory.disconnect();
      saveStore.clear();
      if (await localHistory.connect()) {
        navigate("/progress");
      }
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "Could not open repository.",
      );
    } finally {
      setOpening(undefined);
    }
  };

  const reopen = async () => {
    if (reopening()) {
      return;
    }
    setReopening(true);
    setError(undefined);
    try {
      const result = await localHistory.reopenRepository();
      if (result.kind !== "opened") {
        setError(formatOpenResult(result));
        return;
      }
      localHistory.disconnect();
      saveStore.clear();
      if (await localHistory.connect()) {
        navigate("/progress");
      }
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not reopen repository.",
      );
    } finally {
      setReopening(false);
    }
  };

  const inspectLocalSave = async () => {
    if (runtimeCapabilities.kind !== "desktop") {
      return;
    }
    const result = await runtimeCapabilities.pickStaticEncodedSave();
    applyStaticSaveResult(result, {
      disconnectLocalHistory: localHistory.disconnect,
      loadDecodedSave: saveStore.loadDecodedSave,
      navigateToProgress: () => {
        navigate("/progress");
      },
      reportFailure: (message) => {
        setError(message);
      },
      reportSuccess: () => {
        toastStore.showToast("Local save loaded successfully!");
      },
    });
  };

  onMount(() => {
    refresh().catch(() => undefined);
  });

  return (
    <section class={viewStyles["view"]} data-testid="repository-library">
      <h2 class={viewStyles["heading"]}>Repositories</h2>
      <p>Choose a managed repository or browse an archive read-only.</p>
      <button
        class={buttonStyles["primary"]}
        id="inspect-local-save-from-library"
        type="button"
        onClick={() => {
          inspectLocalSave().catch(() => {
            setError("Unable to inspect local save.");
          });
        }}
      >
        Inspect local save…
      </button>
      <button
        class={buttonStyles["primary"]}
        type="button"
        disabled={loading()}
        onClick={() => {
          refresh().catch(() => undefined);
        }}
      >
        {loading() ? "Refreshing…" : "Refresh"}
      </button>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={connectionError()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>
      <Show when={invalidatedWorkflow()}>
        {(state) => (
          <>
            <p role="alert">
              {state().diagnostic === "protocolFailure"
                ? "Desktop Local History stopped because its local protocol became incompatible. Reopen the selected repository to start a fresh reader session."
                : "Desktop Local History stopped unexpectedly. Reopen the selected repository to start a fresh reader session."}
            </p>
            <button
              class={buttonStyles["primary"]}
              id="reopen-selected-local-history"
              type="button"
              disabled={reopening()}
              onClick={() => {
                reopen().catch(() => undefined);
              }}
            >
              {reopening() ? "Reopening…" : "Reopen selected repository"}
            </button>
          </>
        )}
      </Show>
      <Show when={library()?.stale}>
        <p role="alert">Showing the last successful scan. {library()?.error}</p>
      </Show>
      <Show when={library()?.external}>
        {(entry) => (
          <RepositoryRow entry={entry()} onOpen={open} opening={opening()} />
        )}
      </Show>
      <h3>Managed repositories</h3>
      <RepositoryRows
        entries={library()?.managed ?? []}
        onOpen={open}
        opening={opening()}
      />
      <h3>
        <button
          class={buttonStyles["secondary"]}
          type="button"
          onClick={() => {
            setShowArchives(!showArchives());
          }}
        >
          {showArchives()
            ? "Hide archived repositories"
            : "Show archived repositories"}
        </button>
      </h3>
      <Show when={showArchives()}>
        <RepositoryRows
          entries={library()?.archived ?? []}
          onOpen={open}
          opening={opening()}
        />
      </Show>
      <Show when={(library()?.attention.length ?? 0) > 0}>
        <h3>Need attention</h3>
        <For each={library()?.attention ?? []}>
          {(entry) => (
            <p>
              {entry.name}: {entry.status} — {entry.requiredAction}
            </p>
          )}
        </For>
      </Show>
    </section>
  );
}

function formatOpenResult(
  result: Exclude<OpenExternalRepositoryResult, { readonly kind: "opened" }>,
): string {
  switch (result.kind) {
    case "cancelled": {
      return "Repository selection was cancelled.";
    }

    case "busy": {
      return "Desktop Local History is already changing sessions. Try again when it finishes.";
    }

    case "blockedByMutation": {
      return "Wait for the active Manual Checkpoint or restore to finish before changing repositories.";
    }

    case "requiresAction": {
      return formatRequiredAction(result.action);
    }
  }
}

function formatRequiredAction(
  action: Extract<
    OpenExternalRepositoryResult,
    { readonly kind: "requiresAction" }
  >["action"],
): string {
  switch (action) {
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

function RepositoryRows(props: {
  readonly entries: readonly RepositoryLibraryEntry[];
  readonly onOpen: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly opening?: string;
}) {
  return (
    <Show when={props.entries.length > 0} fallback={<p>None found.</p>}>
      <For each={props.entries}>
        {(entry) => (
          <RepositoryRow
            entry={entry}
            onOpen={props.onOpen}
            opening={props.opening}
          />
        )}
      </For>
    </Show>
  );
}

function RepositoryRow(props: {
  readonly entry: RepositoryLibraryEntry;
  readonly onOpen: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly opening?: string;
}) {
  const key = () => `${props.entry.lifecycle}:${props.entry.name}`;
  const lifecycleLabel = () => {
    if (props.entry.lifecycle === "archived") {
      return "Archived · Read-only";
    }
    if (props.entry.lifecycle === "external") {
      return "External";
    }
    return "Managed";
  };
  const currentLabel = () =>
    props.entry.watching ? "Current · Watching" : "Current · Not watching";
  const openLabel = () => {
    if (props.opening === key()) {
      return "Opening…";
    }
    return props.entry.lifecycle === "archived" ? "Open read-only" : "Open";
  };
  const action = () => {
    if (props.entry.current) {
      return currentLabel();
    }
    if (props.entry.status !== "ready") {
      return props.entry.status;
    }
    return (
      <button
        class={buttonStyles["secondary"]}
        type="button"
        disabled={props.opening !== undefined}
        onClick={() => {
          props.onOpen(props.entry).catch(() => undefined);
        }}
      >
        {openLabel()}
      </button>
    );
  };
  return (
    <div>
      <strong>{props.entry.name}</strong> · {lifecycleLabel()} ·{" "}
      {props.entry.status === "ready" ? "Ready" : props.entry.status} ·{" "}
      {action()}
    </div>
  );
}
