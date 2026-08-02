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
  const hasActiveDesktopSession = () =>
    localHistory.connection().kind === "connected";
  const showSaveNavigation = () =>
    !localHistory.isSupported || hasActiveDesktopSession();
  const homePath = () =>
    localHistory.isSupported && !hasActiveDesktopSession()
      ? "/repositories"
      : "/progress";
  const hasWritableSession = () => {
    const connection = localHistory.connection();
    return (
      connection.kind === "connected"
      && connection.session.access === "readWrite"
    );
  };

  return (
    <aside class={styles["sidebar"]}>
      <A href={homePath()} id="logo-link">
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
        <Show when={localHistory.isSupported}>
          <A
            href="/repositories"
            class={styles["item"]}
            aria-current={currentPage("/repositories")}
          >
            Repositories
          </A>
        </Show>
        <Show when={showSaveNavigation()}>
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
        </Show>
        <Show when={localHistory.connection().kind === "connected"}>
          <A
            href="/history"
            class={styles["item"]}
            aria-current={currentPage("/history")}
          >
            History
          </A>
          <Show when={hasWritableSession()}>
            <A
              href="/diff"
              class={styles["item"]}
              aria-current={currentPage("/diff")}
            >
              Compare
            </A>
          </Show>
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
