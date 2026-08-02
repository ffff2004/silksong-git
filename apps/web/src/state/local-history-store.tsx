import type { JSX, Setter } from "solid-js";
import { createContext, createSignal, useContext } from "solid-js";

import type {
  LocalHttpSaveState,
  LocalHttpWatcherStatus,
} from "@silksong-git/repo-session/http-wire";
import type { LocalHistoryClient } from "../features/local-history/local-history-client.ts";
import {
  LocalHistoryClientError,
  createLocalHistoryClient,
} from "../features/local-history/local-history-client.ts";
import type {
  OpenExternalRepositoryResult,
  RepositoryLibrary,
  RepositoryLifecycle,
  RuntimeCapabilities,
} from "../runtime-capabilities/interface.ts";

interface LocalHistorySession {
  readonly access: "readWrite" | "readOnly";
  readonly client: LocalHistoryClient;
  readonly endpoint: string;
  readonly latestSaveState: () => LocalHttpSaveState | undefined;
  readonly observationRevision: () => number | undefined;
  readonly watcherStatus: () => LocalHttpWatcherStatus | undefined;
}

type LocalHistoryAvailability =
  | { readonly kind: "available" }
  | {
      readonly automaticRequestsPaused: boolean;
      readonly error: LocalHistoryClientError;
      readonly kind: "stale";
    };

export type LocalHistoryConnection =
  | { readonly kind: "disconnected" }
  | { readonly kind: "connecting" }
  | {
      readonly availability: LocalHistoryAvailability;
      readonly kind: "connected";
      readonly session: LocalHistorySession;
    }
  | { readonly error: LocalHistoryClientError; readonly kind: "error" };

export type DesktopWorkflowState =
  | { readonly kind: "active" }
  | { readonly kind: "transitioning" }
  | {
      readonly diagnostic: "sidecarUnavailable" | "protocolFailure";
      readonly kind: "invalidated";
    };

interface LocalHistoryStore {
  readonly closeRepository: () => Promise<void>;
  readonly connect: () => Promise<boolean>;
  readonly connection: () => LocalHistoryConnection;
  readonly disconnect: () => void;
  readonly isSupported: boolean;
  readonly openExternalRepository: () => Promise<OpenExternalRepositoryResult>;
  readonly openLibraryEntry: (input: {
    readonly lifecycle: Exclude<RepositoryLifecycle, "external">;
    readonly name: string;
  }) => Promise<OpenExternalRepositoryResult>;
  readonly repositoryLibrary: () => Promise<RepositoryLibrary>;
  readonly reportRequestFailure: (error: unknown) => void;
  readonly reportRequestSuccess: () => void;
  readonly startWatching: () => Promise<void>;
  readonly stopWatching: () => Promise<void>;
  readonly reopenRepository: () => Promise<OpenExternalRepositoryResult>;
  readonly updateLatestSaveState: (state: LocalHttpSaveState) => void;
  readonly updateWatcherStatus: (status: LocalHttpWatcherStatus) => void;
  readonly workflowState: () => DesktopWorkflowState;
}

const LocalHistoryContext = createContext<LocalHistoryStore>();

export function LocalHistoryProvider(props: {
  readonly children: JSX.Element;
  readonly runtimeCapabilities: RuntimeCapabilities;
}) {
  const [connection, setConnection] = createSignal<LocalHistoryConnection>({
    kind: "disconnected",
  });
  const [workflowState, setWorkflowState] = createSignal<DesktopWorkflowState>({
    kind: "active",
  });
  let setWatcherStatus: Setter<LocalHttpWatcherStatus | undefined> | undefined;
  let setLatestSaveState: Setter<LocalHttpSaveState | undefined> | undefined;
  const discardSession = () => {
    setLatestSaveState = undefined;
    setWatcherStatus = undefined;
    setConnection({ kind: "disconnected" });
  };
  const invalidateDesktopWorkflow = (
    diagnostic: "sidecarUnavailable" | "protocolFailure",
  ) => {
    discardSession();
    setWorkflowState({ diagnostic, kind: "invalidated" });
  };

  const store: LocalHistoryStore = {
    async closeRepository() {
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error(
          "Repository management is unavailable in this runtime.",
        );
      }
      if (props.runtimeCapabilities.closeRepository === undefined) {
        throw new Error(
          "Repository closing is unavailable in this Desktop version.",
        );
      }
      await props.runtimeCapabilities.closeRepository();
      discardSession();
    },
    async connect() {
      setConnection({ kind: "connecting" });

      try {
        if (props.runtimeCapabilities.kind !== "desktop") {
          throw new Error("Local History is unavailable in this runtime.");
        }
        const input =
          await props.runtimeCapabilities.getRepoSessionConnection();
        const client = createLocalHistoryClient(input);
        const initialWatcherStatus = await client.getWatcher();
        const [watcherStatus, setNextWatcherStatus] = createSignal<
          LocalHttpWatcherStatus | undefined
        >(initialWatcherStatus);
        const [latestSaveState, setNextLatestSaveState] = createSignal<
          LocalHttpSaveState | undefined
        >();
        setWatcherStatus = setNextWatcherStatus;
        setLatestSaveState = setNextLatestSaveState;
        setConnection({
          availability: { kind: "available" },
          kind: "connected",
          session: {
            access: input.access ?? "readWrite",
            client,
            endpoint: input.endpoint,
            latestSaveState,
            observationRevision: () => watcherStatus()?.observationRevision,
            watcherStatus,
          },
        });

        return true;
      } catch (error) {
        const clientError = toLocalHistoryClientError(
          error,
          "Local History connection failed.",
        );
        setConnection({
          kind: "error",
          error: clientError,
        });
        if (
          props.runtimeCapabilities.kind === "desktop"
          && (clientError.kind === "unavailable"
            || clientError.kind === "protocol")
        ) {
          invalidateDesktopWorkflow(diagnosticFor(clientError));
        }

        return false;
      }
    },
    connection,
    disconnect() {
      discardSession();
    },
    isSupported: props.runtimeCapabilities.kind === "desktop",
    async openExternalRepository() {
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error("Local History is unavailable in this runtime.");
      }

      setWorkflowState({ kind: "transitioning" });
      try {
        return await props.runtimeCapabilities.openExternalRepository();
      } finally {
        setWorkflowState({ kind: "active" });
      }
    },
    async openLibraryEntry(input) {
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error(
          "Repository management is unavailable in this runtime.",
        );
      }
      if (props.runtimeCapabilities.openLibraryEntry === undefined) {
        throw new Error(
          "Repository Library is unavailable in this Desktop version.",
        );
      }
      setWorkflowState({ kind: "transitioning" });
      try {
        return await props.runtimeCapabilities.openLibraryEntry(input);
      } finally {
        setWorkflowState({ kind: "active" });
      }
    },
    async repositoryLibrary() {
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error(
          "Repository management is unavailable in this runtime.",
        );
      }
      if (props.runtimeCapabilities.getRepositoryLibrary === undefined) {
        throw new Error(
          "Repository Library is unavailable in this Desktop version.",
        );
      }
      return await props.runtimeCapabilities.getRepositoryLibrary();
    },
    reportRequestFailure(error) {
      const current = connection();
      if (current.kind !== "connected") {
        return;
      }
      const clientError = toLocalHistoryClientError(
        error,
        "Local History request failed.",
      );
      if (
        props.runtimeCapabilities.kind === "desktop"
        && (clientError.kind === "unavailable"
          || clientError.kind === "protocol")
      ) {
        invalidateDesktopWorkflow(diagnosticFor(clientError));
        return;
      }
      setConnection({
        ...current,
        availability: {
          automaticRequestsPaused: shouldPauseAutomaticRequests(clientError),
          error: clientError,
          kind: "stale",
        },
      });
    },
    reportRequestSuccess() {
      const current = connection();
      if (
        current.kind === "connected"
        && current.availability.kind === "stale"
      ) {
        setConnection({
          ...current,
          availability: { kind: "available" },
        });
      }
    },
    async startWatching() {
      ensureWorkflowActive(workflowState());
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error("Watching is unavailable in this runtime.");
      }

      await props.runtimeCapabilities.startWatching();
    },
    async stopWatching() {
      ensureWorkflowActive(workflowState());
      if (props.runtimeCapabilities.kind !== "desktop") {
        throw new Error("Watching is unavailable in this runtime.");
      }

      await props.runtimeCapabilities.stopWatching();
    },
    async reopenRepository() {
      if (
        props.runtimeCapabilities.kind !== "desktop"
        || props.runtimeCapabilities.reopenRepository === undefined
      ) {
        throw new Error(
          "Reopening Local History is unavailable in this runtime.",
        );
      }
      const previousWorkflowState = workflowState();
      if (previousWorkflowState.kind !== "invalidated") {
        throw new Error("Local History has not been invalidated.");
      }

      const { diagnostic } = previousWorkflowState;
      setWorkflowState({ kind: "transitioning" });
      try {
        const result = await props.runtimeCapabilities.reopenRepository();
        if (result.kind === "opened") {
          setWorkflowState({ kind: "active" });
        } else {
          setWorkflowState({ diagnostic, kind: "invalidated" });
        }
        return result;
      } catch (error) {
        const clientError = toLocalHistoryClientError(
          error,
          "Local History reopen failed.",
        );
        setWorkflowState({
          diagnostic: diagnosticFor(clientError),
          kind: "invalidated",
        });
        throw error;
      }
    },
    updateLatestSaveState(state) {
      const updateState = setLatestSaveState;
      if (connection().kind === "connected" && updateState !== undefined) {
        updateState(state);
      }
    },
    updateWatcherStatus(status) {
      const updateStatus = setWatcherStatus;
      if (connection().kind === "connected" && updateStatus !== undefined) {
        updateStatus(status);
      }
    },
    workflowState,
  };

  return (
    <LocalHistoryContext.Provider value={store}>
      {props.children}
    </LocalHistoryContext.Provider>
  );
}

function ensureWorkflowActive(state: DesktopWorkflowState) {
  if (state.kind === "transitioning") {
    throw new Error("Desktop Local History is changing sessions.");
  }
  if (state.kind === "invalidated") {
    throw new Error(
      "Desktop Local History must be reopened before starting new work.",
    );
  }
}

function diagnosticFor(
  error: LocalHistoryClientError,
): "sidecarUnavailable" | "protocolFailure" {
  return error.kind === "protocol" ? "protocolFailure" : "sidecarUnavailable";
}

function toLocalHistoryClientError(
  error: unknown,
  fallbackMessage: string,
): LocalHistoryClientError {
  return error instanceof LocalHistoryClientError
    ? error
    : new LocalHistoryClientError(
        { kind: "protocol", message: fallbackMessage },
        { cause: error },
      );
}

function shouldPauseAutomaticRequests(error: LocalHistoryClientError): boolean {
  return ["local-network-denied", "protocol", "unauthorized"].includes(
    error.kind,
  );
}

export function useLocalHistoryStore(): LocalHistoryStore {
  const store = useContext(LocalHistoryContext);
  if (store === undefined) {
    throw new Error("Local History store is not available.");
  }

  return store;
}
