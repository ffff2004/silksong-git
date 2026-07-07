import { createMemo, createSignal } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
import { useSaveStore } from "../../state/save-store.tsx";
import { InfoModal } from "../progress/InfoModal.tsx";
import type { ProgressItemData } from "../progress/progress-types.ts";
import { MapFiltersPanel } from "./MapFiltersPanel.tsx";
import { MapPinsLayer } from "./MapPinsLayer.tsx";
import type { MapPinView } from "./map-selectors.ts";
import {
  getMapCategories,
  getMapPins,
  resolveMapImageSrc,
} from "./map-selectors.ts";
import { useMapPanZoom } from "./use-map-pan-zoom.ts";

const mapOptions = [
  {
    label: "Act 3",
    src: "assets/ui/labelled_map_act3.png",
  },
  {
    label: "Room's Name",
    src: "assets/ui/scene's_name_map.png",
  },
] as const;

export function MapView() {
  let image: HTMLImageElement | undefined;
  let stage: HTMLDivElement | undefined;
  let wrapper: HTMLDivElement | undefined;
  const saveStore = useSaveStore();
  const categories = getMapCategories();
  const [selectedMapSrc, setSelectedMapSrc] = createSignal<string>(
    "assets/ui/labelled_map_act3.png",
  );
  const [searchTerm, setSearchTerm] = createSignal("");
  const [isFiltersOpen, setIsFiltersOpen] = createSignal(false);
  const [activeCategories, setActiveCategories] = createSignal<
    ReadonlySet<string>
  >(new Set(categories));
  const [infoItem, setInfoItem] = createSignal<ProgressItemData>();
  const currentMapSrc = () => resolveMapImageSrc(selectedMapSrc());
  const pins = createMemo(() =>
    getMapPins({
      activeCategories: activeCategories(),
      currentMapSrc: currentMapSrc(),
      isObtained,
      searchTerm: searchTerm(),
    }),
  );

  useMapPanZoom({
    getImage: () => image,
    getStage: () => stage,
    getWrapper: () => wrapper,
  });

  return (
    <>
      <section id="map-section" class="tab" data-testid="map-view">
        <h2>Interactive Map</h2>
        <div class="map-controls">
          <label for="map-act-select">Select Map:</label>
          <select
            id="map-act-select"
            aria-label="Select map act"
            value={selectedMapSrc()}
            onChange={(event) => {
              setSelectedMapSrc(event.currentTarget.value);
            }}
          >
            {mapOptions.map((option) => (
              <option value={option.src}>{option.label}</option>
            ))}
          </select>
        </div>
        <div class="map-wrapper" ref={wrapper}>
          <div id="worldMapStage" ref={stage}>
            <div id="worldMapInner" class="world-map-inner">
              <img
                id="worldMap"
                ref={image}
                src={assetUrl(selectedMapSrc())}
                draggable={false}
                alt="Pharloom Map"
              />
              <MapPinsLayer
                pins={pins()}
                onOpenInfo={(pin: MapPinView) => {
                  setInfoItem(pin.item);
                }}
              />
            </div>
          </div>
        </div>
        <MapFiltersPanel
          activeCategories={activeCategories()}
          categories={categories}
          isOpen={isFiltersOpen()}
          onSearch={(term) => {
            setSearchTerm(term);
          }}
          onSetAllCategories={(checked) => {
            setActiveCategories(
              checked ? new Set<string>(categories) : new Set<string>(),
            );
          }}
          onToggleCategory={(category, checked) => {
            const nextCategories = new Set(activeCategories());
            if (checked) {
              nextCategories.add(category);
            } else {
              nextCategories.delete(category);
            }
            setActiveCategories(nextCategories);
          }}
          onToggleOpen={() => {
            setIsFiltersOpen(!isFiltersOpen());
          }}
          searchCount={pins().length}
          searchTerm={searchTerm()}
        />
      </section>
      <InfoModal
        item={infoItem()}
        onClose={() => {
          setInfoItem(undefined);
        }}
      />
    </>
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
