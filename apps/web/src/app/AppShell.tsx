import type { JSX } from "solid-js";

import { BackToTop } from "../shell/BackToTop.tsx";
import { Sidebar } from "../shell/Sidebar.tsx";
import { Topbar } from "../shell/Topbar.tsx";
import { LocalHistoryRuntime } from "../state/local-history-runtime.tsx";
import { ToastHost } from "../ui/ToastHost.tsx";

export function AppShell(props: { readonly children?: JSX.Element }) {
  return (
    <>
      <LocalHistoryRuntime />
      <Sidebar />
      <div class="main-wrapper">
        <Topbar />
        <main id="main">
          <BackToTop />
          {props.children}
        </main>
      </div>
      <ToastHost />
    </>
  );
}
