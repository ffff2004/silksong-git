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

export type LocalHistoryConnection =
  | { readonly kind: "disconnected" }
  | { readonly kind: "connecting" }
  | { readonly kind: "connected"; readonly session: LocalHistorySession }
  | { readonly error: LocalHistoryClientError; readonly kind: "error" };

interface LocalHistoryStore {
  readonly connect: (input: {
    readonly endpoint: string;
    readonly token: string;
  }) => Promise<boolean>;
  readonly connection: () => LocalHistoryConnection;
  readonly disconnect: () => void;
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
          kind: "connected",
          session: { client, endpoint: input.endpoint, meta },
        });

        return true;
      } catch (error) {
        const clientError =
          error instanceof LocalHistoryClientError
            ? error
            : new LocalHistoryClientError(
                {
                  kind: "protocol",
                  message: "Local History connection failed.",
                },
                { cause: error },
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
  };

  return (
    <LocalHistoryContext.Provider value={store}>
      {props.children}
    </LocalHistoryContext.Provider>
  );
}

export function useLocalHistoryStore(): LocalHistoryStore {
  const store = useContext(LocalHistoryContext);
  if (store === undefined) {
    throw new Error("Local History store is not available.");
  }

  return store;
}
