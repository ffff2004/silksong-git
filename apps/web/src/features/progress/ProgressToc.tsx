import { For } from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";
import { useSaveStore } from "../../state/save-store.tsx";
import {
  getProgressSectionTitle,
  getVisibleCategoryView,
} from "./progress-selectors.ts";
import type {
  ProgressItemData,
  ProgressSectionData,
} from "./progress-types.ts";
import { toHeadingId } from "./ProgressSection.tsx";

interface ProgressTocProps {
  readonly sections: readonly ProgressSectionData[];
}

export function ProgressToc(props: ProgressTocProps) {
  const saveStore = useSaveStore();
  const preferences = usePreferencesStore();

  const visibleSections = () =>
    props.sections
      .map((section) => {
        const title = getProgressSectionTitle(section);
        const categories = section.categories.filter(
          (category) =>
            getVisibleCategoryView({
              category,
              hasSave: saveStore.hasSave(),
              isObtained,
              mode: saveStore.mode(),
              sectionTitle: title,
              selectedActs: preferences.selectedActs(),
              showOnlyMissing: preferences.showOnlyMissing(),
            }) !== undefined,
        );

        return { categories, section, title };
      })
      .filter((section) => section.categories.length > 0);

  return (
    <nav id="toc" class="toc-container">
      <ul id="toc-list">
        <For each={visibleSections()}>
          {(entry) => (
            <li class="toc-category open">
              <a href={`#${toHeadingId(entry.title)}`}>{entry.title}</a>
              <ul class="toc-sublist">
                <For each={entry.categories}>
                  {(category) => (
                    <li class="toc-item">
                      <a
                        href={`#${toHeadingId(`${entry.title} ${category.label}`)}`}
                      >
                        {category.label}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </li>
          )}
        </For>
      </ul>
      <div class="toc-legend">
        <div class="legend-title">Legend</div>
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
    </nav>
  );

  function isObtained(item: ProgressItemData): boolean {
    const status = saveStore.semanticItem(item.id)?.status;
    if (
      item.type === "relic"
      || item.type === "materium"
      || item.type === "device"
    ) {
      return status === "done" || status === "accepted";
    }

    return status === "done";
  }
}
