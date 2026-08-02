import type { JSX } from "solid-js";
import { Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import viewStyles from "../../ui/View.module.css";
import { hasQueryParam } from "./url-utils.ts";

export function LocalRoute(props: { readonly children: JSX.Element }) {
  const localHistory = useLocalHistoryStore();

  return (
    <Show
      when={
        localHistory.workflowState().kind === "active"
        && localHistory.connection().kind === "connected"
      }
      fallback={
        localHistory.isSupported ? (
          <ConnectionRequiredState />
        ) : (
          <BrowserUnavailableState />
        )
      }
    >
      {props.children}
    </Show>
  );
}

function ConnectionRequiredState() {
  const localHistory = useLocalHistoryStore();
  const invalidated = () => {
    const state = localHistory.workflowState();
    return state.kind === "invalidated" ? state : undefined;
  };
  return (
    <section class={viewStyles["view"]} data-testid="local-connection-required">
      <h2 class={viewStyles["heading"]}>Local History connection required</h2>
      <p>Open a repository from Repositories to open this view.</p>
      <Show when={invalidated()}>
        {(state) => (
          <>
            <p role="alert">
              {state().diagnostic === "protocolFailure"
                ? "Desktop Local History stopped because its local protocol became incompatible. Reopen the selected repository to start a fresh reader session."
                : "Desktop Local History stopped unexpectedly. Reopen the selected repository to start a fresh reader session."}
            </p>
            <button
              id="reopen-selected-local-history"
              type="button"
              onClick={() => {
                localHistory.reopenRepository().catch(() => undefined);
              }}
            >
              Reopen selected repository
            </button>
          </>
        )}
      </Show>
    </section>
  );
}

function BrowserUnavailableState() {
  return (
    <section class={viewStyles["view"]} data-testid="browser-unavailable">
      <h2 class={viewStyles["heading"]}>
        Local History is unavailable in the browser
      </h2>
      <p>Open this view in the Desktop application to use Local History.</p>
    </section>
  );
}

export function CurrentSaveRoute(props: { readonly children: JSX.Element }) {
  const localHistory = useLocalHistoryStore();

  return (
    <Show
      when={
        localHistory.workflowState().kind === "active"
        && (!hasCommitSelection(globalThis.location.hash)
          || localHistory.connection().kind === "connected")
      }
      fallback={
        localHistory.isSupported ? (
          <ConnectionRequiredState />
        ) : (
          <BrowserUnavailableState />
        )
      }
    >
      {props.children}
    </Show>
  );
}

function hasCommitSelection(hash: string): boolean {
  return hasQueryParam(hash.split("?", 2)[1] ?? "", "commit");
}
