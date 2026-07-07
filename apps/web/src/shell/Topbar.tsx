import { ModeBanner } from "../features/current-save/ModeBanner.tsx";
import { PreferenceControls } from "../features/current-save/PreferenceControls.tsx";
import { SaveControls } from "../features/current-save/SaveControls.tsx";

export function Topbar() {
  return (
    <header class="topbar">
      <ModeBanner />
      <div class="topbar-right">
        <PreferenceControls />
        <SaveControls />
      </div>
    </header>
  );
}
