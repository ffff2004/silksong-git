import { useLocation, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { ModeBanner } from "../features/current-save/ModeBanner.tsx";
import { PreferenceControls } from "../features/current-save/PreferenceControls.tsx";
import { SaveControls } from "../features/current-save/SaveControls.tsx";
import { HistoricalSelectionBanner } from "../features/local-history/HistoricalSelectionBanner.tsx";
import { LocalConnectionDialog } from "../features/local-history/LocalConnectionDialog.tsx";
import { hasQueryParam } from "../features/local-history/url-utils.ts";
import { useLocalHistoryStore } from "../state/local-history-store.tsx";
import { useSaveStore } from "../state/save-store.tsx";

export function Topbar() {
  const localHistory = useLocalHistoryStore();
  const saveStore = useSaveStore();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <header class="topbar">
      <div class="topbar-primary-row">
        <ModeBanner />
        <div class="topbar-right">
          <PreferenceControls />
          <Show when={localHistory.connection().kind !== "connected"}>
            <SaveControls />
          </Show>
          <LocalConnectionDialog
            onConnected={() => {
              saveStore.clear();
              if (
                (location.pathname === "/" || location.pathname === "/progress")
                && !hasQueryParam(location.search, "commit")
              ) {
                navigate("/progress");
              }
            }}
          />
        </div>
      </div>
      <HistoricalSelectionBanner />
    </header>
  );
}
