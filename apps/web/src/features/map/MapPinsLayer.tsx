import { For } from "solid-js";

import type { MapPinView } from "./map-selectors.ts";

interface MapPinsLayerProps {
  readonly onOpenInfo: (pin: MapPinView) => void;
  readonly pins: readonly MapPinView[];
}

export function MapPinsLayer(props: MapPinsLayerProps) {
  return (
    <div id="mapPinsOverlay">
      <For each={props.pins}>
        {(pin) => (
          <button
            type="button"
            class="map-pin"
            classList={{ obtained: pin.isObtained }}
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              props.onOpenInfo(pin);
            }}
            aria-label={pin.item.label}
          >
            <img src={pin.iconSrc} alt="" draggable={false} />
          </button>
        )}
      </For>
    </div>
  );
}
