import { A, useLocation } from "@solidjs/router";
import { Show } from "solid-js";

import { assetUrl } from "../app/asset-url.ts";
import { useLocalHistoryStore } from "../state/local-history-store.tsx";

export function Sidebar() {
  const location = useLocation();
  const localHistory = useLocalHistoryStore();
  const isActive = (path: string) => location.pathname === path;

  return (
    <aside class="sidebar">
      <A href="/progress" id="logo-link">
        <div class="sidebar-header">
          <img
            src={assetUrl("assets/misc/favicon.png")}
            class="logo-icon"
            width="64"
            height="64"
            alt="Silksong Git Logo"
          />
          <div class="app-name">Silksong Git</div>
        </div>
      </A>
      <div class="sidebar-links">
        <a
          href="https://hollowknight.wiki"
          target="_blank"
          rel="noreferrer"
          class="sidebar-wiki-btn"
        >
          Wiki
        </a>
      </div>
      <div class="sidebar-actions">
        <a
          href="https://github.com/ffff2004/silksong-git"
          class="icon-btn"
          title="GitHub Repository"
          target="_blank"
          rel="noreferrer"
        >
          <i class="fab fa-github" />
        </a>
      </div>
      <div class="sidebar-divider" />
      <div class="sidebar-section">
        <A
          href="/progress"
          class="sidebar-item"
          classList={{ "is-active": isActive("/progress") }}
        >
          Progress
        </A>
        <A
          href="/map"
          class="sidebar-item"
          classList={{ "is-active": isActive("/map") }}
        >
          Interactive Map
        </A>
        <A
          href="/raw-save"
          class="sidebar-item"
          classList={{ "is-active": isActive("/raw-save") }}
        >
          Raw Save Data
        </A>
        <Show when={localHistory.connection().kind === "connected"}>
          <A
            href="/history"
            class="sidebar-item"
            classList={{ "is-active": isActive("/history") }}
          >
            History
          </A>
          <A
            href="/diff"
            class="sidebar-item"
            classList={{ "is-active": isActive("/diff") }}
          >
            Compare
          </A>
          <A
            href="/watcher"
            class="sidebar-item"
            classList={{ "is-active": isActive("/watcher") }}
          >
            Watcher
          </A>
        </Show>
      </div>
    </aside>
  );
}
