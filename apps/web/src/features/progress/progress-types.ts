import type { MappingData } from "@silksong-git/core";

export type ProgressSectionData = Omit<
  MappingData["sections"][number],
  "categories"
> & {
  readonly categories: readonly ProgressCategoryData[];
};

export type ProgressCategoryData = Omit<
  MappingData["sections"][number]["categories"][number],
  "items"
> & {
  readonly description?: string;
  readonly items: readonly ProgressItemData[];
};

export type ProgressItemData =
  MappingData["sections"][number]["categories"][number]["items"][number] & {
    readonly act?: number;
    readonly cost?: string;
    readonly description?: string;
    readonly group?: string;
    readonly hornetDescription?: string;
    readonly icon?: string;
    readonly link?: string;
    readonly map?: string;
    readonly mapCategory?: string;
    readonly mapViewer?: {
      readonly src: string;
      readonly x: number;
      readonly y: number;
      readonly zoom?: number;
    };
    readonly missable?: boolean;
    readonly mode?: "normal" | "steel";
    readonly obtain?: string;
    readonly showOnMap?: boolean;
    readonly unobtainable?: boolean;
    readonly upgradeOf?: string;
    readonly use?: string;
  };
