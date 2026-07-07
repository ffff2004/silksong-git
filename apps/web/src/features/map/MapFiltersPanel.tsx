import { For } from "solid-js";

import { formatMapCategory } from "./map-selectors.ts";

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
    <div class="map-sidebar" classList={{ collapsed: !props.isOpen }}>
      <div id="map-filters-body" classList={{ open: props.isOpen }}>
        <div class="map-sidebar-header">
          <h3>Map Filters</h3>
          <button
            id="toggle-map-filters"
            class="map-filter-toggle"
            type="button"
            title="Hide filters"
            onClick={props.onToggleOpen}
          >
            <i class="fa-solid fa-sliders" />
            <span>Hide Filters</span>
          </button>
        </div>
        <div class="search-container">
          <input
            type="text"
            id="map-search"
            placeholder="Search item..."
            autocomplete="off"
            value={props.searchTerm}
            onInput={(event) => {
              props.onSearch(event.currentTarget.value);
            }}
          />
          <span id="map-search-count">
            {props.searchTerm === ""
              ? ""
              : `${props.searchCount} result${props.searchCount === 1 ? "" : "s"}`}
          </span>
        </div>
        <div class="filter-controls">
          <button
            id="show-all-filters"
            class="btn-small"
            type="button"
            onClick={() => {
              props.onSetAllCategories(true);
            }}
          >
            Show All
          </button>
          <button
            id="hide-all-filters"
            class="btn-small"
            type="button"
            onClick={() => {
              props.onSetAllCategories(false);
            }}
          >
            Hide All
          </button>
        </div>
        <div id="map-filters" class="filter-list">
          <For each={props.categories}>
            {(category) => (
              <label class="filter-item">
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
        class="map-filter-show-btn"
        type="button"
        onClick={props.onToggleOpen}
      >
        <i class="fa-solid fa-sliders" />
        <span>Show Filters</span>
      </button>
    </div>
  );
}
