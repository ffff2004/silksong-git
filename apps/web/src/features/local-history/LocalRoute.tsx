import type { JSX } from "solid-js";
import { Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import viewStyles from "../../ui/View.module.css";
import { hasQueryParam } from "./url-utils.ts";

export function LocalRoute(props: { readonly children: JSX.Element }) {
  const localHistory = useLocalHistoryStore();

  return (
    <Show
      when={localHistory.connection().kind === "connected"}
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
  return (
    <section class={viewStyles["view"]} data-testid="local-connection-required">
      <h2 class={viewStyles["heading"]}>Local History connection required</h2>
      <p>Connect to Local History from the Topbar to open this view.</p>
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
        !hasCommitSelection(globalThis.location.hash)
        || localHistory.connection().kind === "connected"
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
