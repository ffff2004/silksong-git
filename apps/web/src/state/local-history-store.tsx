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

interface LocalHistorySession {
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

interface LocalHistoryStore {
  readonly connect: (input: {
    readonly endpoint: string;
    readonly token: string;
  }) => Promise<boolean>;
  readonly connection: () => LocalHistoryConnection;
  readonly disconnect: () => void;
  readonly reportRequestFailure: (error: unknown) => void;
  readonly reportRequestSuccess: () => void;
  readonly updateLatestSaveState: (state: LocalHttpSaveState) => void;
  readonly updateWatcherStatus: (status: LocalHttpWatcherStatus) => void;
}

const LocalHistoryContext = createContext<LocalHistoryStore>();

export function LocalHistoryProvider(props: {
  readonly children: JSX.Element;
}) {
  const [connection, setConnection] = createSignal<LocalHistoryConnection>({
    kind: "disconnected",
  });
  let setWatcherStatus: Setter<LocalHttpWatcherStatus | undefined> | undefined;
  let setLatestSaveState: Setter<LocalHttpSaveState | undefined> | undefined;

  const store: LocalHistoryStore = {
    async connect(input) {
      setConnection({ kind: "connecting" });

      try {
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

        return false;
      }
    },
    connection,
    disconnect() {
      setLatestSaveState = undefined;
      setWatcherStatus = undefined;
      setConnection({ kind: "disconnected" });
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
  };

  return (
    <LocalHistoryContext.Provider value={store}>
      {props.children}
    </LocalHistoryContext.Provider>
  );
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
