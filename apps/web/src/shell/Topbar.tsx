import { useNavigate } from "@solidjs/router";

import { ModeBanner } from "../features/current-save/ModeBanner.tsx";
import { PreferenceControls } from "../features/current-save/PreferenceControls.tsx";
import { SaveControls } from "../features/current-save/SaveControls.tsx";
import { LocalConnectionDialog } from "../features/local-history/LocalConnectionDialog.tsx";
import { useSaveStore } from "../state/save-store.tsx";

export function Topbar() {
  const saveStore = useSaveStore();
  const navigate = useNavigate();

  return (
    <header class="topbar">
      <ModeBanner />
      <div class="topbar-right">
        <PreferenceControls />
        <SaveControls />
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
