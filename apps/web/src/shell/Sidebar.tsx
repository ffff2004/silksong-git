import { A, useLocation } from "@solidjs/router";
import { Show } from "solid-js";

import { assetUrl } from "../app/asset-url.ts";
import { useLocalHistoryStore } from "../state/local-history-store.tsx";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  const location = useLocation();
  const localHistory = useLocalHistoryStore();
  const isActive = (path: string) =>
    location.pathname === path
    || (path === "/progress" && location.pathname === "/");

  const currentPage = (path: string) => (isActive(path) ? "page" : undefined);

  return (
    <aside class={styles["sidebar"]}>
      <A href="/progress" id="logo-link">
        <div class={styles["header"]}>
          <img
            src={assetUrl("assets/misc/favicon.png")}
            class={styles["logoIcon"]}
            width="64"
            height="64"
            alt="Silksong Git Logo"
          />
          <div class={styles["appName"]}>Silksong Git</div>
        </div>
      </A>
      <div class={styles["links"]}>
        <a
          href="https://hollowknight.wiki"
          target="_blank"
          rel="noreferrer"
          class={styles["wikiButton"]}
        >
          Wiki
        </a>
      </div>
      <div class={styles["actions"]}>
        <a
          href="https://github.com/ffff2004/silksong-git"
          class={styles["iconButton"]}
          title="GitHub Repository"
          target="_blank"
          rel="noreferrer"
        >
          <i class="fab fa-github" />
        </a>
      </div>
      <div class={styles["divider"]} />
      <nav aria-label="Primary navigation">
        <A
          href="/progress"
          class={styles["item"]}
          aria-current={currentPage("/progress")}
        >
          Progress
        </A>
        <A
          href="/map"
          class={styles["item"]}
          aria-current={currentPage("/map")}
        >
          Interactive Map
        </A>
        <A
          href="/raw-save"
          class={styles["item"]}
          aria-current={currentPage("/raw-save")}
        >
          Raw Save Data
        </A>
        <Show when={localHistory.connection().kind === "connected"}>
          <A
            href="/history"
            class={styles["item"]}
            aria-current={currentPage("/history")}
          >
            History
          </A>
          <A
            href="/diff"
            class={styles["item"]}
            aria-current={currentPage("/diff")}
          >
            Compare
          </A>
          <A
            href="/watcher"
            class={styles["item"]}
            aria-current={currentPage("/watcher")}
          >
            Watcher
          </A>
        </Show>
      </nav>
    </aside>
  );
}
