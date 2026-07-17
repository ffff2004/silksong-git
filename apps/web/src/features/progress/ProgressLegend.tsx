import { Show } from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";
import styles from "./ProgressLegend.module.css";

export function ProgressLegend() {
  const preferences = usePreferencesStore();
  const isCollapsed = preferences.progressLegendCollapsed;

  return (
    <aside
      aria-label="Progress legend"
      class={styles["legend"]}
      classList={{ [styles["collapsed"]!]: isCollapsed() }}
    >
      <button
        type="button"
        aria-controls="progress-legend-content"
        aria-expanded={!isCollapsed()}
        aria-label={isCollapsed() ? "Expand legend" : "Collapse legend"}
        class={styles["toggle"]}
        onClick={() => {
          preferences.setProgressLegendCollapsed(!isCollapsed());
        }}
      >
        <i class="fa-solid fa-circle-info" />
        <span class={styles["toggleLabel"]}>Legend</span>
      </button>
      <Show when={!isCollapsed()}>
        <div id="progress-legend-content" class={styles["content"]}>
          <ul class={styles["list"]}>
            <li>
              <i class="fa-solid fa-arrow-up" /> Upgrade of another tool
            </li>
            <li>
              <i class="fa-solid fa-code-branch" /> Mutually exclusive item
            </li>
            <li>
              <span class={styles["missable"]}>!</span> Missable item
            </li>
          </ul>
        </div>
      </Show>
    </aside>
  );
}
