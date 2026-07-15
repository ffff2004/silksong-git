import type { JSX } from "solid-js";
import { createContext, createSignal, useContext } from "solid-js";

import type { LocalHttpMeta } from "@silksong-git/history/http-wire";
import type { LocalHistoryClient } from "../features/local-history/local-history-client.ts";
import {
  LocalHistoryClientError,
  assertLocalHistoryCompatibility,
  createLocalHistoryClient,
} from "../features/local-history/local-history-client.ts";

interface LocalHistorySession {
  readonly client: LocalHistoryClient;
  readonly endpoint: string;
  readonly meta: LocalHttpMeta;
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
}

const LocalHistoryContext = createContext<LocalHistoryStore>();

export function LocalHistoryProvider(props: {
  readonly children: JSX.Element;
}) {
  const [connection, setConnection] = createSignal<LocalHistoryConnection>({
    kind: "disconnected",
  });

  const store: LocalHistoryStore = {
    async connect(input) {
      setConnection({ kind: "connecting" });

      try {
        const client = createLocalHistoryClient(input);
        const meta = await client.getMeta();
        assertLocalHistoryCompatibility(meta);
        setConnection({
          availability: { kind: "available" },
          kind: "connected",
          session: { client, endpoint: input.endpoint, meta },
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
  return ["incompatible", "protocol", "unauthorized"].includes(error.kind);
}

export function useLocalHistoryStore(): LocalHistoryStore {
  const store = useContext(LocalHistoryContext);
  if (store === undefined) {
    throw new Error("Local History store is not available.");
  }

  return store;
}
