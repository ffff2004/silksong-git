import { useLocation } from "@solidjs/router";
import type { JSX } from "solid-js";

import { BackToTop } from "../shell/BackToTop.tsx";
import { Sidebar } from "../shell/Sidebar.tsx";
import { Topbar } from "../shell/Topbar.tsx";
import { LocalHistoryRuntime } from "../state/local-history-runtime.tsx";
import { ToastHost } from "../ui/ToastHost.tsx";

export function AppShell(props: { readonly children?: JSX.Element }) {
  const location = useLocation();
  const isWideCurrentSaveRoute = () =>
    location.pathname === "/map" || location.pathname === "/raw-save";

  return (
    <>
      <LocalHistoryRuntime />
      <Sidebar />
      <div class="main-wrapper">
        <Topbar />
        <main
          id="main"
          style={{ "margin-right": isWideCurrentSaveRoute() ? "0px" : "310px" }}
        >
          <BackToTop />
          {props.children}
        </main>
      </div>
      <ToastHost />
    </>
  );
}
