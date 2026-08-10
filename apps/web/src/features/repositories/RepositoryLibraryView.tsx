import { useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";

import type {
  OpenExternalRepositoryResult,
  RepositoryArchiveSnapshot,
  RepositoryLibrary,
  RepositoryLibraryEntry,
  RepositoryMigrationSnapshotState,
  RepositoryOpenIntent,
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

interface RebuildState {
  readonly key: string;
  readonly status: "queued" | "running";
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
  const [archiving, setArchiving] = createSignal<string>();
  const [archivedHighlight, setArchivedHighlight] = createSignal<string>();
  const [rebuild, setRebuild] = createSignal<RebuildState>();
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
  const [importing, setImporting] = createSignal(false);
  const [replacing, setReplacing] = createSignal(false);
  const repositorySwitchingDisabled = () =>
    opening() !== undefined
    || archiving() !== undefined
    || rebuild() !== undefined
    || migrating()
    || migration() !== undefined
    || initializing()
    || importing()
    || replacing()
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

  const refresh = async (): Promise<boolean> => {
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
      return true;
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not refresh repositories.",
      );
      return false;
    } finally {
      setLoading(false);
    }
  };

  const open = async (
    entry: RepositoryLibraryEntry,
    intent: RepositoryOpenIntent,
  ) => {
    if (
      entry.current
      || opening() !== undefined
      || repositorySwitchingDisabled()
    ) {
      return;
    }
    const key = `${entry.lifecycle}:${entry.name}`;
    const rebuildRequested = intent === "rebuild";
    setOpening(key);
    if (rebuildRequested) {
      setRebuild({ key, status: "queued" });
      // The native call owns inspection and rebuild. Yield once so the landing UI can expose the
      // local queued state without introducing a progress endpoint or a persistent job queue.
      await Promise.resolve();
      if (rebuild()?.key === key) {
        setRebuild({ key, status: "running" });
      }
    }
    setError(undefined);
    try {
      const result = await localHistory.openLibraryEntry({
        lifecycle: entry.lifecycle === "archived" ? "archived" : "managed",
        name: entry.name,
        intent,
      });
      if (result.kind !== "opened") {
        const refreshAfterFailure =
          rebuildRequested
          || (entry.lifecycle === "managed"
            && result.kind === "requiresAction"
            && result.status === "rebuildRequired");
        await reportFailedOpen(
          entry,
          formatOpenResult(result),
          refreshAfterFailure,
        );
        return;
      }
      localHistory.disconnect();
      saveStore.clear();
      if (await localHistory.connect()) {
        navigate("/progress");
      }
    } catch (error_) {
      await reportFailedOpen(
        entry,
        error_ instanceof Error ? error_.message : "Could not open repository.",
        rebuildRequested,
      );
    } finally {
      setOpening(undefined);
      setRebuild(undefined);
    }
  };

  const reportFailedOpen = async (
    entry: RepositoryLibraryEntry,
    message: string,
    refreshAfterFailure: boolean,
  ) => {
    if (!refreshAfterFailure) {
      setError(message);
      return;
    }

    const refreshed = await refresh();
    if (!refreshed) {
      setError(
        `${message} The repository list could not be refreshed. Click Refresh, then try again.`,
      );
      return;
    }
    const currentEntry = [
      ...(library()?.managed ?? []),
      ...(library()?.archived ?? []),
      ...(library()?.attention ?? []),
    ].find(
      (candidate) =>
        candidate.lifecycle === entry.lifecycle
        && candidate.name === entry.name,
    );
    setError(
      currentEntry?.status === "rebuildRequired"
        ? `${message} Click Rebuild to try again.`
        : `${message} The repository list was refreshed; try opening the repository again.`,
    );
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

  const archiveRepository = async (entry: RepositoryLibraryEntry) => {
    if (entry.lifecycle !== "managed" || repositorySwitchingDisabled()) {
      return;
    }
    if (
      // eslint-disable-next-line no-alert
      !globalThis.confirm(
        `Archive ${entry.name}? This stops App-owned watching, closes its Repo Session, and moves the repository into the App-managed archive.`,
      )
    ) {
      return;
    }

    const key = `${entry.lifecycle}:${entry.name}`;
    setArchiving(key);
    setError(undefined);
    setArchivedHighlight(undefined);
    try {
      const result = await localHistory.archiveRepository({
        lifecycle: "managed",
        name: entry.name,
      });
      if (result.kind === "archived") {
        if (entry.current) {
          localHistory.disconnect();
          saveStore.clear();
        }
        setShowArchives(true);
        setArchivedHighlight(result.name);
        toastStore.showToast(`Archived ${entry.name} successfully!`);
        await refresh();
      } else {
        const message = formatArchiveResult(result);
        await refresh();
        setError(message);
      }
    } catch (error_) {
      const message =
        error_ instanceof Error
          ? error_.message
          : "Could not archive repository.";
      await refresh();
      setError(message);
    } finally {
      setArchiving(undefined);
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
      if (!(await refresh())) {
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
          if (
            // eslint-disable-next-line no-alert
            !globalThis.confirm(
              "Archive the current managed repository, then initialize the selected save as its replacement? The archive is retained for recovery.",
            )
          ) {
            break;
          }
          setInitializing(false);
          await archiveAndReinitializeManagedRepository();
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

  const archiveAndReinitializeManagedRepository = async () => {
    if (
      replacing()
      || repositorySwitchingDisabled()
      || runtimeCapabilities.kind !== "desktop"
      || runtimeCapabilities.archiveAndReinitializeManagedRepository
        === undefined
    ) {
      return;
    }

    setReplacing(true);
    setError(undefined);
    try {
      const result =
        await localHistory.archiveAndReinitializeManagedRepository();
      if (result.kind === "succeeded") {
        localHistory.disconnect();
        saveStore.clear();
        if (await localHistory.connect()) {
          navigate("/progress");
        }
        await refresh();
        if (result.cleanupWarning === undefined) {
          toastStore.showToast("Managed repository replaced successfully!");
        } else {
          setError(
            `Replacement completed, but lease cleanup needs attention. Archive: ${result.archivePath}`,
          );
        }
        return;
      }
      if (result.kind === "cancelled") {
        return;
      }
      if (result.kind === "failed") {
        const locations = [
          result.managedPath === undefined
            ? undefined
            : `Managed location: ${result.managedPath}.`,
          result.archivePath === undefined
            ? undefined
            : `Archive location: ${result.archivePath}.`,
          result.replacementResidualPath === undefined
            ? undefined
            : `Replacement residual: ${result.replacementResidualPath}.`,
        ].filter((location): location is string => location !== undefined);
        setError(
          [
            result.message,
            `Rollback: ${result.rollback}.`,
            ...locations,
            result.rollback === "failed"
              ? "Keep these locations intact while recovering the managed repository."
              : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(" "),
        );
        return;
      }
      setError(
        result.kind === "blockedByMutation"
          ? "Wait for active work or an external watcher to finish before replacing the repository."
          : "Desktop Local History is already changing sessions. Try again when it finishes.",
      );
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not replace the managed repository.",
      );
    } finally {
      setReplacing(false);
    }
  };

  const importRepository = async () => {
    if (
      runtimeCapabilities.kind !== "desktop"
      || runtimeCapabilities.importRepository === undefined
      || importing()
      || repositorySwitchingDisabled()
    ) {
      return;
    }
    setImporting(true);
    setError(undefined);
    try {
      const result = await localHistory.importRepository();
      switch (result.kind) {
        case "cancelled": {
          break;
        }

        case "imported": {
          if (await refresh()) {
            if (result.cleanupFailure === "leaseReleaseFailed") {
              setError(
                `Imported ${result.name}, but History could not confirm lease cleanup. Restart Desktop before retrying repository work.`,
              );
            } else {
              toastStore.showToast(`Imported ${result.name} successfully!`);
            }
          } else {
            setError(
              `Repository ${result.name} was imported, but the repository list could not be refreshed.`,
            );
          }
          break;
        }

        case "rejected": {
          const cleanupWarning =
            result.cleanupFailure === "leaseReleaseFailed"
              ? " History could not confirm lease cleanup; restart Desktop before retrying repository work."
              : "";
          await refresh();
          setError(`${result.message}${cleanupWarning}`);
          return;
        }

        case "failed": {
          const cleanupWarning =
            result.cleanupFailure === "leaseReleaseFailed"
              ? " History could not confirm lease cleanup; restart Desktop before retrying repository work."
              : "";
          await refresh();
          setError(
            `${result.residualPath === undefined ? result.message : `${result.message} Retained copy: ${result.residualPath}`}${cleanupWarning}`,
          );
          break;
        }
      }
    } catch (error_) {
      setError(
        error_ instanceof Error
          ? error_.message
          : "Could not import the external repository.",
      );
    } finally {
      setImporting(false);
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
        id="import-repository"
        type="button"
        disabled={importing() || repositorySwitchingDisabled()}
        onClick={() => {
          importRepository().catch(() => {
            setError("Could not import the external repository.");
          });
        }}
      >
        {importing() ? "Importing…" : "Import repository…"}
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
            onArchive={archiveRepository}
            opening={opening()}
            rebuild={rebuild()}
            switchingDisabled={repositorySwitchingDisabled()}
          />
        )}
      </Show>
      <h3>Managed repositories</h3>
      <RepositoryRows
        entries={library()?.managed ?? []}
        onOpen={open}
        onArchive={archiveRepository}
        onMigrate={prepareMigration}
        opening={opening()}
        rebuild={rebuild()}
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
          highlightedName={archivedHighlight()}
          opening={opening()}
          rebuild={rebuild()}
          switchingDisabled={repositorySwitchingDisabled()}
        />
      </Show>
      <Show when={(library()?.attention.length ?? 0) > 0}>
        <h3>Need attention</h3>
        <RepositoryRows
          entries={library()?.attention ?? []}
          onOpen={open}
          onArchive={archiveRepository}
          opening={opening()}
          rebuild={rebuild()}
          migrating={migrating()}
          switchingDisabled={repositorySwitchingDisabled()}
        />
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

function formatArchiveResult(
  result: Exclude<
    Awaited<
      ReturnType<ReturnType<typeof useLocalHistoryStore>["archiveRepository"]>
    >,
    { readonly kind: "archived" }
  >,
): string {
  switch (result.kind) {
    case "busy": {
      return "Desktop Local History is already changing sessions. Try again when it finishes.";
    }

    case "failed": {
      if (result.reason === "watcherAlreadyAcquired") {
        return "Another process owns this repository watcher. Stop it before archiving.";
      }
      return (
        result.message ?? `Could not archive repository (${result.reason}).`
      );
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
  readonly onOpen: (
    entry: RepositoryLibraryEntry,
    intent: RepositoryOpenIntent,
  ) => Promise<void>;
  readonly onMigrate?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly onArchive?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly highlightedName?: string;
  readonly opening?: string;
  readonly rebuild?: RebuildState;
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
            onArchive={props.onArchive}
            highlighted={props.highlightedName === entry.name}
            opening={props.opening}
            rebuild={props.rebuild}
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
  readonly onOpen: (
    entry: RepositoryLibraryEntry,
    intent: RepositoryOpenIntent,
  ) => Promise<void>;
  readonly onMigrate?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly onArchive?: (entry: RepositoryLibraryEntry) => Promise<void>;
  readonly highlighted?: boolean;
  readonly opening?: string;
  readonly rebuild?: RebuildState;
  readonly migrating?: boolean;
  readonly switchingDisabled?: boolean;
}) {
  const key = () => `${props.entry.lifecycle}:${props.entry.name}`;
  const lifecycleLabel = () => {
    if (props.entry.lifecycle === "archived") {
      return props.entry.status === "ready"
        || props.entry.status === "legacyConfig"
        || props.entry.status === "migrationRequired"
        ? "Archived · Read-only"
        : "Archived · Unavailable";
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
  const rebuildLabel = () => {
    if (props.rebuild?.key !== key()) {
      return "Rebuild";
    }
    return props.rebuild.status === "queued"
      ? "Rebuild queued…"
      : "Rebuilding…";
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
        && props.entry.status === "rebuildRequired"
      ) {
        return (
          <button
            class={buttonStyles["secondary"]}
            type="button"
            disabled={
              props.rebuild !== undefined
              || props.opening !== undefined
              || props.switchingDisabled === true
            }
            onClick={() => {
              props.onOpen(props.entry, "rebuild").catch(() => undefined);
            }}
          >
            {rebuildLabel()}
          </button>
        );
      }
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
          props.onOpen(props.entry, "open").catch(() => undefined);
        }}
      >
        {openLabel()}
      </button>
    );
  };
  return (
    <div
      class={
        props.highlighted === true ? viewStyles["archiveHighlight"] : undefined
      }
      data-archive-highlight={props.highlighted === true ? "true" : undefined}
    >
      <strong>{props.entry.name}</strong> · {lifecycleLabel()} ·{" "}
      {props.entry.status === "ready" ? "Ready" : props.entry.status} ·{" "}
      {action()}
      <Show
        when={
          props.entry.lifecycle === "managed" && props.onArchive !== undefined
        }
      >
        <button
          class={buttonStyles["secondary"]}
          type="button"
          title="Archive repository"
          aria-label="Archive repository"
          disabled={props.switchingDisabled === true}
          onClick={() => {
            props.onArchive?.(props.entry).catch(() => undefined);
          }}
        >
          <i class="fa-solid fa-box-archive" aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
}
