import { Show } from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";

export function ProgressLegend() {
  const preferences = usePreferencesStore();
  const isCollapsed = preferences.progressLegendCollapsed;

  return (
    <aside
      aria-label="Progress legend"
      class="progress-legend"
      classList={{ collapsed: isCollapsed() }}
    >
      <button
        type="button"
        aria-controls="progress-legend-content"
        aria-expanded={!isCollapsed()}
        aria-label={isCollapsed() ? "Expand legend" : "Collapse legend"}
        class="progress-legend-toggle"
        onClick={() => {
          preferences.setProgressLegendCollapsed(!isCollapsed());
        }}
      >
        <i class="fa-solid fa-circle-info" />
        <span class="progress-legend-toggle-label">Legend</span>
      </button>
      <Show when={!isCollapsed()}>
        <div id="progress-legend-content" class="progress-legend-content">
          <ul class="legend-list">
            <li>
              <i class="fa-solid fa-arrow-up" /> Upgrade of another tool
            </li>
            <li>
              <i class="fa-solid fa-code-branch" /> Mutually exclusive item
            </li>
            <li>
              <span class="legend-missable">!</span> Missable item
            </li>
          </ul>
        </div>
      </Show>
    </aside>
  );
}
