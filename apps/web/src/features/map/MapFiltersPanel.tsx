import { For } from "solid-js";

import buttonStyles from "../../ui/Button.module.css";
import { formatMapCategory } from "./map-selectors.ts";
import styles from "./MapFiltersPanel.module.css";

interface MapFiltersPanelProps {
  readonly activeCategories: ReadonlySet<string>;
  readonly categories: readonly string[];
  readonly isOpen: boolean;
  readonly onSearch: (searchTerm: string) => void;
  readonly onSetAllCategories: (checked: boolean) => void;
  readonly onToggleCategory: (category: string, checked: boolean) => void;
  readonly onToggleOpen: () => void;
  readonly searchCount: number;
  readonly searchTerm: string;
}

export function MapFiltersPanel(props: MapFiltersPanelProps) {
  return (
    <div
      class={`${styles["sidebar"]} ${props.isOpen ? "" : styles["collapsed"]}`}
    >
      <div id="map-filters-body" class={styles["body"]} hidden={!props.isOpen}>
        <div class={styles["header"]}>
          <h3 class={styles["heading"]}>Map Filters</h3>
          <button
            id="toggle-map-filters"
            class={styles["hide-button"]}
            type="button"
            title="Hide filters"
            aria-controls="map-filters-body"
            aria-expanded={props.isOpen}
            onClick={props.onToggleOpen}
          >
            <i class="fa-solid fa-sliders" />
            <span>Hide Filters</span>
          </button>
        </div>
        <div class={styles["search-container"]}>
          <input
            type="text"
            id="map-search"
            class={styles["search"]}
            role="searchbox"
            aria-label="Search map items"
            placeholder="Search item..."
            autocomplete="off"
            value={props.searchTerm}
            onInput={(event) => {
              props.onSearch(event.currentTarget.value);
            }}
          />
          <span id="map-search-count" class={styles["search-count"]}>
            {props.searchTerm === ""
              ? ""
              : `${props.searchCount} result${props.searchCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <div class={styles["filter-controls"]}>
          <button
            id="show-all-filters"
            class={buttonStyles["small"]}
            type="button"
            onClick={() => {
              props.onSetAllCategories(true);
            }}
          >
            Show All
          </button>
          <button
            id="hide-all-filters"
            class={buttonStyles["small"]}
            type="button"
            onClick={() => {
              props.onSetAllCategories(false);
            }}
          >
            Hide All
          </button>
        </div>
        <div id="map-filters" class={styles["filter-list"]}>
          <For each={props.categories}>
            {(category) => (
              <label class={styles["filter-item"]}>
                <input
                  type="checkbox"
                  data-category={category}
                  checked={props.activeCategories.has(category)}
                  onChange={(event) => {
                    props.onToggleCategory(
                      category,
                      event.currentTarget.checked,
                    );
                  }}
                />
                <span>{formatMapCategory(category)}</span>
              </label>
            )}
          </For>
        </div>
      </div>
      <button
        id="toggle-map-filters-collapsed"
        class={styles["show-button"]}
        type="button"
        aria-controls="map-filters-body"
        aria-expanded={props.isOpen}
        hidden={props.isOpen}
        onClick={props.onToggleOpen}
      >
        <i class="fa-solid fa-sliders" />
        <span>Show Filters</span>
      </button>
    </div>
  );
}
