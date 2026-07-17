import { For, createSignal } from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";
import styles from "./PreferenceControls.module.css";

const acts = [1, 2, 3] as const;

export function PreferenceControls() {
  const preferences = usePreferencesStore();
  const [isActsOpen, setIsActsOpen] = createSignal(false);

  return (
    <>
      <div id="act-filter" class={styles["dropdown"]}>
        <button
          class={styles["dropdown-toggle"]}
          id="acts-dropdown-button"
          type="button"
          aria-controls="acts-dropdown-menu"
          aria-expanded={isActsOpen()}
          onClick={() => {
            setIsActsOpen(!isActsOpen());
          }}
        >
          <i class="fa-solid fa-feather-pointed" /> Acts{" "}
          <i class="fa-solid fa-chevron-down" />
        </button>
        <div
          id="acts-dropdown-menu"
          class={styles["dropdown-menu"]}
          role="group"
          aria-label="Act filters"
          hidden={!isActsOpen()}
        >
          <For each={acts}>
            {(act) => (
              <label>
                <input
                  type="checkbox"
                  value={act}
                  checked={preferences.selectedActs().includes(act)}
                  onChange={(event) => {
                    const selected = new Set(preferences.selectedActs());
                    if (event.currentTarget.checked) {
                      selected.add(act);
                    } else {
                      selected.delete(act);
                    }
                    preferences.setSelectedActs([...selected]);
                  }}
                />{" "}
                Act {romanAct(act)}
              </label>
            )}
          </For>
        </div>
      </div>
      <label class={styles["toggle"]}>
        <input
          type="checkbox"
          id="show-only-missing"
          checked={preferences.showOnlyMissing()}
          onChange={(event) => {
            preferences.setShowOnlyMissing(event.currentTarget.checked);
          }}
        />{" "}
        Show only missing
      </label>
      <label>
        <input
          type="checkbox"
          id="show-spoilers"
          checked={preferences.showSpoilers()}
          onChange={(event) => {
            preferences.setShowSpoilers(event.currentTarget.checked);
          }}
        />{" "}
        Show spoilers
      </label>
    </>
  );
}

function romanAct(act: number): string {
  if (act === 1) {
    return "I";
  }

  if (act === 2) {
    return "II";
  }

  return "III";
}
