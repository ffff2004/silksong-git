import { getBuiltinMappingData } from "@silksong-git/core";

import type { SaveMode } from "../current-save/load-current-save.ts";
import type {
  ProgressCategoryData,
  ProgressItemData,
  ProgressSectionData,
} from "./progress-types.ts";

const sectionTitles = new Map([
  ["bosses", "Bosses"],
  ["completion", "Completion"],
  ["essentials", "Essential Items"],
  ["journal", "Journal"],
  ["main", "Main Progress"],
  ["mini-bosses", "Mini-Bosses"],
  ["scenes", "Rooms"],
  ["wishes", "Wishes"],
]);

export interface ProgressCategoryView {
  readonly category: ProgressCategoryData;
  readonly items: readonly ProgressItemData[];
  readonly obtained: number;
  readonly sectionTitle: string;
  readonly total: number;
}

export function getProgressSections(): readonly ProgressSectionData[] {
  return getBuiltinMappingData().sections;
}

export function getProgressSectionTitle(section: ProgressSectionData): string {
  return sectionTitles.get(section.id) ?? section.label;
}

export function getAllProgressItems(): readonly ProgressItemData[] {
  return getProgressSections().flatMap((section) =>
    section.categories.flatMap((category) => category.items),
  );
}

export function getVisibleCategoryView(input: {
  readonly category: ProgressCategoryData;
  readonly hasSave: boolean;
  readonly isObtained: (item: ProgressItemData) => boolean;
  readonly mode: SaveMode;
  readonly sectionTitle: string;
  readonly selectedActs: readonly number[];
  readonly showOnlyMissing: boolean;
}): ProgressCategoryView | undefined {
  const obtainedGroups = new Set<string>();
  if (input.hasSave) {
    for (const item of input.category.items) {
      if (
        typeof item.group === "string"
        && item.group.trim() !== ""
        && input.isObtained(item)
      ) {
        obtainedGroups.add(item.group);
      }
    }
  }

  let items = input.category.items.filter(
    (item) =>
      input.selectedActs.includes(item.act ?? 1)
      && itemMatchesSaveMode(item, input.hasSave, input.mode),
  );

  if (input.showOnlyMissing && input.hasSave) {
    items = items.filter((item) => !input.isObtained(item));
  }

  let obtained = 0;
  let total = 0;
  for (const item of items) {
    if (item.type === "tool" && item.upgradeOf !== undefined) {
      continue;
    }

    if (
      input.hasSave
      && item.unobtainable === true
      && typeof item.group === "string"
      && item.group.trim() !== ""
      && obtainedGroups.has(item.group)
      && !input.isObtained(item)
    ) {
      continue;
    }

    total++;
    if (input.hasSave && input.isObtained(item)) {
      obtained++;
    }
  }

  if (items.length === 0 || (input.showOnlyMissing && total === 0)) {
    return undefined;
  }

  return {
    category: input.category,
    items,
    obtained,
    sectionTitle: input.sectionTitle,
    total,
  };
}

function itemMatchesSaveMode(
  item: ProgressItemData,
  hasSave: boolean,
  mode: SaveMode,
): boolean {
  if (item.mode === undefined || !hasSave) {
    return true;
  }

  return item.mode === mode;
}
