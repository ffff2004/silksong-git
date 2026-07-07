import { assetUrl } from "../../app/asset-url.ts";
import { getAllProgressItems } from "../progress/progress-selectors.ts";
import type { ProgressItemData } from "../progress/progress-types.ts";

export interface MapPinView {
  readonly category: string;
  readonly iconSrc: string;
  readonly isObtained: boolean;
  readonly item: ProgressItemData;
  readonly x: number;
  readonly y: number;
}

export function getMapCategories(): readonly string[] {
  return [
    ...new Set(
      getAllProgressItems()
        .map((item) => item.mapCategory)
        .filter((category): category is string => typeof category === "string"),
    ),
  ].toSorted();
}

export function getMapPins(input: {
  readonly activeCategories: ReadonlySet<string>;
  readonly currentMapSrc: string;
  readonly isObtained: (item: ProgressItemData) => boolean;
  readonly searchTerm: string;
}): readonly MapPinView[] {
  return getAllProgressItems()
    .filter(
      (item) =>
        item.showOnMap === true
        && item.mapViewer !== undefined
        && typeof item.mapCategory === "string"
        && input.activeCategories.has(item.mapCategory)
        && resolveMapImageSrc(item.mapViewer.src) === input.currentMapSrc
        && fuzzyMatch(item.label, input.searchTerm),
    )
    .flatMap((item) => {
      const { mapCategory, mapViewer } = item;
      if (mapCategory === undefined || mapViewer === undefined) {
        return [];
      }

      return [
        {
          category: mapCategory,
          iconSrc: resolveIconSrc(item.icon),
          isObtained: input.isObtained(item),
          item,
          x: mapViewer.x,
          y: mapViewer.y,
        },
      ];
    });
}

export function formatMapCategory(category: string): string {
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function resolveMapImageSrc(src: string): string {
  const clean = src.trim();
  if (clean.startsWith("http")) {
    return clean;
  }

  return assetUrl(clean);
}

function resolveIconSrc(icon: string | undefined): string {
  const clean = (icon ?? "").trim();
  if (clean === "") {
    return "";
  }

  if (clean.startsWith("http")) {
    return clean;
  }

  if (clean.startsWith("assets/")) {
    return assetUrl(clean);
  }

  return assetUrl(`assets/${clean}`);
}

function fuzzyMatch(text: string, pattern: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();
  if (normalizedPattern === "") {
    return true;
  }

  return normalizedText.includes(normalizedPattern);
}
