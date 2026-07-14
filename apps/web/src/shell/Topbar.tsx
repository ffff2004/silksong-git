import { useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { ModeBanner } from "../features/current-save/ModeBanner.tsx";
import { PreferenceControls } from "../features/current-save/PreferenceControls.tsx";
import { SaveControls } from "../features/current-save/SaveControls.tsx";
import { LocalConnectionDialog } from "../features/local-history/LocalConnectionDialog.tsx";
import { useLocalHistoryStore } from "../state/local-history-store.tsx";
import { useSaveStore } from "../state/save-store.tsx";

export function Topbar() {
  const localHistory = useLocalHistoryStore();
  const saveStore = useSaveStore();
  const navigate = useNavigate();

  return (
    <header class="topbar">
      <ModeBanner />
      <div class="topbar-right">
        <PreferenceControls />
        <Show when={localHistory.connection().kind !== "connected"}>
          <SaveControls />
        </Show>
        <LocalConnectionDialog
          onConnected={() => {
            saveStore.clear();
            navigate("/progress");
          }}
        />
      </div>
    </header>
  );
}
