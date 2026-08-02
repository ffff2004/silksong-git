import { ModeBanner } from "../features/current-save/ModeBanner.tsx";
import { PreferenceControls } from "../features/current-save/PreferenceControls.tsx";
import { SaveControls } from "../features/current-save/SaveControls.tsx";
import { HistoricalSelectionBanner } from "../features/local-history/HistoricalSelectionBanner.tsx";
import styles from "./Topbar.module.css";

export function Topbar() {
  return (
    <header class={styles["topbar"]}>
      <div
        class={styles["primaryRow"]}
        role="group"
        aria-label="Primary controls"
      >
        <ModeBanner />
        <div
          class={styles["rightControls"]}
          role="group"
          aria-label="Save and preference controls"
        >
          <PreferenceControls />
          <SaveControls />
        </div>
      </div>
      <div class={styles["historicalRow"]}>
        <HistoricalSelectionBanner />
      </div>
    </header>
  );
}
