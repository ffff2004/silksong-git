import { useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";

import type {
  OpenExternalRepositoryResult,
  RepositoryArchiveSnapshot,
  RepositoryLibrary,
  RepositoryLibraryEntry,
  RepositoryMigrationSnapshotState,
} from "../../runtime-capabilities/interface.ts";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { useRuntimeCapabilities } from "../../state/runtime-capabilities.tsx";
import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import viewStyles from "../../ui/View.module.css";
import { applyStaticSaveResult } from "../current-save/static-save-result.ts";

interface MigrationOutcome {
  readonly cleanupFailure?: "leaseReleaseFailed";
  readonly reason: string;
  readonly snapshotState: RepositoryMigrationSnapshotState;
  readonly sourceName: string;
  readonly sourceState: "unchanged" | "migrated" | "unknown";
  readonly status: "failed" | "migrated" | "rejected";
}

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
  const [migration, setMigration] = createSignal<{
    readonly entry: RepositoryLibraryEntry;
    readonly snapshot: RepositoryArchiveSnapshot;
  }>();
  const [migrationOutcome, setMigrationOutcome] =
    createSignal<MigrationOutcome>();
  const [migrating, setMigrating] = createSignal(false);
  const [initializing, setInitializing] = createSignal(false);
  const [existingInitialization, setExistingInitialization] =
    createSignal<string>();
  const repositorySwitchingDisabled = () =>
    migrating()
    || migration() !== undefined
    || initializing()
    || localHistory.workflowState().kind === "transitioning";
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
    if (
      entry.current
      || opening() !== undefined
      || repositorySwitchingDisabled()
    ) {
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

  const prepareMigration = async (entry: RepositoryLibraryEntry) => {
    if (
      entry.lifecycle !== "managed"
      || (entry.status !== "legacyConfig"
        && entry.status !== "migrationRequired")
      || migrating()
    ) {
      return;
    }
    // The final confirmation is intentionally owned by Desktop's workflow UI.
    if (
      // eslint-disable-next-line no-alert
      !globalThis.confirm(
        "Create a verified archive snapshot before migrating this repository?",
      )
    ) {
      return;
    }

    setMigrating(true);
    setError(undefined);
    setMigrationOutcome(undefined);
    try {
      const result = await localHistory.prepareRepositoryMigration({
        lifecycle: "managed",
        name: entry.name,
      });
      if (result.kind !== "prepared") {
        setError(formatMigrationPreparationResult(result));
        return;
      }
      setMigration({ entry, snapshot: result.snapshot });
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not create the archive snapshot.",
      );
    } finally {
      setMigrating(false);
    }
  };

  const commitMigration = async () => {
    const pendingMigration = migration();
    if (pendingMigration === undefined || migrating()) {
      return;
    }
    // Final confirmation consumes the one-way operation. Remove the action before the native
    // request starts so a terminal result or a lost response cannot expose a dead retry button.
    setMigration(undefined);
    setMigrating(true);
    setError(undefined);
    try {
      const result = await localHistory.commitRepositoryMigration();
      if (result.status !== "migrated") {
        setMigrationOutcome({
          ...(result.cleanupFailure !== undefined && {
            cleanupFailure: result.cleanupFailure,
          }),
          reason: result.reason,
          snapshotState: result.snapshotState,
          sourceName: pendingMigration.entry.name,
          sourceState: result.sourceState,
          status: result.status,
        });
        return;
      }
      if (result.cleanupFailure === undefined) {
        setMigrationOutcome(undefined);
      } else {
        setMigrationOutcome({
          cleanupFailure: result.cleanupFailure,
          reason: "leaseReleaseFailed",
          snapshotState: result.snapshotState,
          sourceName: pendingMigration.entry.name,
          sourceState: result.sourceState,
          status: result.status,
        });
      }
      try {
        await refresh();
      } catch {
        setError(
          "Migration completed, but the repository list could not be refreshed.",
        );
      }
    } catch (error_) {
      setMigrationOutcome({
        reason:
          error_ instanceof Error
            ? error_.message
            : "The migration result was unavailable.",
        snapshotState: {
          repoPath: pendingMigration.snapshot.repoPath,
          status: "retained",
        },
        sourceName: pendingMigration.entry.name,
        sourceState: "unknown",
        status: "failed",
      });
    } finally {
      setMigrating(false);
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

  const initializeManagedRepository = async () => {
    if (
      runtimeCapabilities.kind !== "desktop"
      || runtimeCapabilities.initializeManagedRepository === undefined
      || initializing()
      || repositorySwitchingDisabled()
    ) {
      return;
    }
    setInitializing(true);
    setError(undefined);
    setExistingInitialization(undefined);
    try {
      const result = await localHistory.initializeManagedRepository();
      switch (result.kind) {
        case "initialized": {
          localHistory.disconnect();
          saveStore.clear();
          if (await localHistory.connect()) {
            navigate("/progress");
          }
          break;
        }

        case "existingRepository": {
          setExistingInitialization(result.name);
          break;
        }

        case "failed": {
          setError(
            result.residualPath === undefined
              ? result.message
              : `${result.message} Residual candidate: ${result.residualPath}`,
          );
          break;
        }

        case "blockedByMutation": {
          setError(
            "Wait for the active Desktop mutation to finish before initializing a repository.",
          );
          break;
        }

        case "busy": {
          setError(
            "Desktop Local History is already changing sessions. Try again when it finishes.",
          );
          break;
        }

        case "cancelled": {
          break;
        }
      }
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not initialize the managed repository.",
      );
    } finally {
      setInitializing(false);
    }
  };

  const openExistingInitialization = async () => {
    const name = existingInitialization();
    if (name === undefined) {
      return;
    }
    setOpening(`managed:${name}`);
    try {
      const result = await localHistory.openLibraryEntry({
        lifecycle: "managed",
        name,
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
    } finally {
      setOpening(undefined);
    }
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
        id="initialize-managed-repository"
        type="button"
        disabled={initializing() || repositorySwitchingDisabled()}
        onClick={() => {
          initializeManagedRepository().catch(() => {
            setError("Could not initialize the managed repository.");
          });
        }}
      >
        {initializing() ? "Initializing…" : "Initialize and watch save…"}
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
      <Show when={existingInitialization()}>
        {(name) => (
          <div role="status">
            <p>A managed repository already tracks this Watched Save.</p>
            <button
              class={buttonStyles["secondary"]}
              type="button"
              disabled={
                opening() !== undefined || repositorySwitchingDisabled()
              }
              onClick={() => {
                openExistingInitialization().catch(() => {
                  setError("Could not open the existing managed repository.");
                });
              }}
            >
              Open {name()}
            </button>
          </div>
        )}
      </Show>
      <Show when={migration()}>
        {(pending) => (
          <div role="status">
            <p>
              Verified archive snapshot published at:{" "}
              {pending().snapshot.repoPath}
            </p>
            <Show when={pending().snapshot.gitIntegrityWarning}>
              {(warning) => <p role="alert">Git warning: {warning()}</p>}
            </Show>
            <button
              class={buttonStyles["primary"]}
              type="button"
              disabled={migrating()}
              onClick={() => {
                commitMigration().catch(() => undefined);
              }}
            >
              {migrating() ? "Migrating…" : "Start migration"}
            </button>
          </div>
        )}
      </Show>
      <Show when={migrationOutcome()}>
        {(outcome) => (
          <div role="status" data-testid="repository-migration-outcome">
            <p>
              {outcome().status === "migrated"
                ? "Migration completed with a cleanup warning."
                : `Migration did not complete (${outcome().reason}).`}
            </p>
            <p>
              Source repository ({outcome().sourceName}):{" "}
              {formatMigrationSourceState(outcome().sourceState)}
            </p>
            <p>
              Archive snapshot:{" "}
              {formatMigrationSnapshotState(outcome().snapshotState)}
            </p>
            <Show when={outcome().cleanupFailure !== undefined}>
              <p role="alert">
                Cleanup warning: History could not confirm all lease cleanup.
                Restart Desktop before retrying repository work.
              </p>
            </Show>
          </div>
        )}
      </Show>
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
          <RepositoryRow
            entry={entry()}
            onOpen={open}
            opening={opening()}
            switchingDisabled={repositorySwitchingDisabled()}
          />
        )}
      </Show>
      <h3>Managed repositories</h3>
      <RepositoryRows
        entries={library()?.managed ?? []}
        onOpen={open}
        onMigrate={prepareMigration}
        opening={opening()}
        migrating={migrating()}
        switchingDisabled={repositorySwitchingDisabled()}
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
          switchingDisabled={repositorySwitchingDisabled()}
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

function formatMigrationSourceState(
  sourceState: MigrationOutcome["sourceState"],
): string {
  switch (sourceState) {
    case "unchanged": {
      return "the source was not modified.";
    }

    case "migrated": {
      return "the source was migrated before the final result failed.";
    }

    case "unknown": {
      return "the source state is unknown and must be checked before further work.";
    }
  }
}

function formatMigrationSnapshotState(
  snapshotState: RepositoryMigrationSnapshotState,
): string {
  return snapshotState.status === "retained"
    ? `preserved as an Archived Repository (read-only) at ${snapshotState.repoPath}.`
    : "no archive snapshot was published.";
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

function formatMigrationPreparationResult(
  result: Exclude<
    Awaited<
      ReturnType<
        ReturnType<typeof useLocalHistoryStore>["prepareRepositoryMigration"]
      >
    >,
    { readonly kind: "prepared" }
  >,
): string {
  switch (result.kind) {
    case "busy": {
      return "Desktop Local History is already changing sessions. Try again when it finishes.";
    }

    case "blockedByMutation": {
      return "Wait for the active Desktop work to finish before creating an archive snapshot.";
    }

    case "requiresAction": {
      return formatRequiredAction(result.action);
    }

    case "failed": {
      return result.message ?? `Archive snapshot failed (${result.reason}).`;
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
  readonly onMigrate?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly opening?: string;
  readonly migrating?: boolean;
  readonly switchingDisabled?: boolean;
}) {
  return (
    <Show when={props.entries.length > 0} fallback={<p>None found.</p>}>
      <For each={props.entries}>
        {(entry) => (
          <RepositoryRow
            entry={entry}
            onOpen={props.onOpen}
            onMigrate={props.onMigrate}
            opening={props.opening}
            migrating={props.migrating}
            switchingDisabled={props.switchingDisabled}
          />
        )}
      </For>
    </Show>
  );
}

function RepositoryRow(props: {
  readonly entry: RepositoryLibraryEntry;
  readonly onOpen: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly onMigrate?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly opening?: string;
  readonly migrating?: boolean;
  readonly switchingDisabled?: boolean;
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
    const archiveIsReadOnlyOpenable =
      props.entry.lifecycle === "archived"
      && (props.entry.status === "legacyConfig"
        || props.entry.status === "migrationRequired");
    if (props.entry.status !== "ready" && !archiveIsReadOnlyOpenable) {
      if (
        props.entry.lifecycle === "managed"
        && (props.entry.status === "legacyConfig"
          || props.entry.status === "migrationRequired")
        && props.onMigrate !== undefined
      ) {
        return (
          <button
            class={buttonStyles["secondary"]}
            type="button"
            disabled={
              props.migrating === true || props.switchingDisabled === true
            }
            onClick={() => {
              props.onMigrate?.(props.entry).catch(() => undefined);
            }}
          >
            {props.migrating === true ? "Preparing…" : "Migrate"}
          </button>
        );
      }
      return props.entry.status;
    }
    return (
      <button
        class={buttonStyles["secondary"]}
        type="button"
        disabled={
          props.opening !== undefined || props.switchingDisabled === true
        }
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
