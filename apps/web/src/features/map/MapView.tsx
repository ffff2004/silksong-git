import { createMemo, createSignal } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
import { useSaveStore } from "../../state/save-store.tsx";
import { InfoModal } from "../progress/InfoModal.tsx";
import type { ProgressItemData } from "../progress/progress-types.ts";
import type { InteractiveMapPin } from "./InteractiveMapCanvas.tsx";
import { InteractiveMapCanvas } from "./InteractiveMapCanvas.tsx";
import type { MapPinView } from "./map-selectors.ts";
import {
  getMapCategories,
  getMapPins,
  resolveMapImageSrc,
} from "./map-selectors.ts";
import { MapFiltersPanel } from "./MapFiltersPanel.tsx";
import styles from "./MapView.module.css";

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
  const interactivePins = createMemo(() => pins().map(toInteractiveMapPin));

  return (
    <>
      <section
        id="map-section"
        class={styles["page"]}
        data-testid="map-view"
        aria-labelledby="map-title"
      >
        <h2 id="map-title" class={styles["title"]}>
          Interactive Map
        </h2>
        <div class={styles["controls"]}>
          <label for="map-act-select">Select Map:</label>
          <select
            id="map-act-select"
            class={styles["select"]}
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
        <InteractiveMapCanvas
          alt="Pharloom Map"
          imageId="worldMap"
          imageSrc={assetUrl(selectedMapSrc())}
          onActivatePin={(pin) => {
            setInfoItem(pin.payload);
          }}
          pins={interactivePins()}
          variant="page"
        />
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

function toInteractiveMapPin(
  pin: MapPinView,
): InteractiveMapPin<ProgressItemData> {
  return {
    iconSrc: pin.iconSrc,
    id: pin.item.id,
    isObtained: pin.isObtained,
    label: pin.item.label,
    payload: pin.item,
    x: pin.x,
    y: pin.y,
  };
}
