import type { JSX } from "solid-js";

import { BackToTop } from "../shell/BackToTop.tsx";
import { Sidebar } from "../shell/Sidebar.tsx";
import { Topbar } from "../shell/Topbar.tsx";
import { LocalHistoryRuntime } from "../state/local-history-runtime.tsx";
import { ToastHost } from "../ui/ToastHost.tsx";
import styles from "./AppShell.module.css";

export function AppShell(props: { readonly children?: JSX.Element }) {
  return (
    <>
      <LocalHistoryRuntime />
      <Sidebar />
      <div class={styles["wrapper"]}>
        <Topbar />
        <main id="main" class={styles["main"]} aria-label="Application content">
          <BackToTop />
          {props.children}
        </main>
      </div>
      <ToastHost />
    </>
  );
}
