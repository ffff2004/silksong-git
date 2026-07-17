import { For, Show } from "solid-js";

import { usePreferencesStore } from "../../state/preferences-store.tsx";
import {
  getProgressSectionTitle,
  getVisibleCategoryView,
} from "./progress-selectors.ts";
import { useProgressSnapshot } from "./progress-snapshot-context.tsx";
import type {
  ProgressItemData,
  ProgressSectionData,
} from "./progress-types.ts";
import { ProgressItemCard } from "./ProgressItemCard.tsx";
import styles from "./ProgressSection.module.css";

interface ProgressSectionProps {
  readonly onOpenInfo: (item: ProgressItemData) => void;
  readonly section: ProgressSectionData;
}

export function ProgressSection(props: ProgressSectionProps) {
  const progressSnapshot = useProgressSnapshot();
  const preferences = usePreferencesStore();
  const title = () => getProgressSectionTitle(props.section);
  const categoryViews = () =>
    props.section.categories
      .map((category) =>
        getVisibleCategoryView({
          category,
          hasSave: progressSnapshot.hasSave(),
          isObtained,
          mode: progressSnapshot.mode(),
          sectionTitle: title(),
          selectedActs: preferences.selectedActs(),
          shouldIncludeItem: progressSnapshot.shouldShowItem,
          showOnlyMissing: preferences.showOnlyMissing(),
        }),
      )
      .filter((view) => view !== undefined);

  return (
    <Show when={categoryViews().length > 0}>
      <h2 class={styles["sectionHeading"]} id={toHeadingId(title())}>
        {title()}
      </h2>
      <For each={categoryViews()}>
        {(view) => (
          <div class={styles["category"]}>
            <h3
              class={styles["categoryHeading"]}
              id={toHeadingId(`${title()} ${view.category.label}`)}
            >
              {view.category.label}
              <span class={styles["count"]}>
                {" "}
                {view.obtained}/{view.total}
              </span>
            </h3>
            <p class={styles["description"]}>{view.category.description}</p>
            <div class={styles["grid"]}>
              <For each={view.items}>
                {(item) => (
                  <ProgressItemCard item={item} onOpenInfo={props.onOpenInfo} />
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </Show>
  );

  function isObtained(item: ProgressItemData): boolean {
    const status = progressSnapshot.semanticItem(item.id)?.status;
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

export function toHeadingId(label: string): string {
  return `section-${label
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^\w-]/g, "")}`;
}
