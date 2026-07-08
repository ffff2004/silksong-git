import { For } from "solid-js";

import type { MapPanZoomFocus } from "./use-map-pan-zoom.ts";
import { useMapPanZoom } from "./use-map-pan-zoom.ts";

export interface InteractiveMapPin<TPayload = unknown> {
  readonly iconSrc: string;
  readonly id: string;
  readonly isObtained?: boolean;
  readonly label: string;
  readonly payload: TPayload;
  readonly x: number;
  readonly y: number;
}

interface InteractiveMapCanvasProps<TPayload> {
  readonly alt: string;
  readonly focus?: MapPanZoomFocus;
  readonly imageId?: string;
  readonly imageSrc: string;
  readonly onActivatePin?: (pin: InteractiveMapPin<TPayload>) => void;
  readonly pins?: ReadonlyArray<InteractiveMapPin<TPayload>>;
  readonly variant: "modal" | "page";
}

export function InteractiveMapCanvas<TPayload>(
  props: InteractiveMapCanvasProps<TPayload>,
) {
  let image: HTMLImageElement | undefined;
  let stage: HTMLDivElement | undefined;
  let wrapper: HTMLDivElement | undefined;

  useMapPanZoom({
    getFocus: () => props.focus,
    getImage: () => image,
    getStage: () => stage,
    getWrapper: () => wrapper,
  });

  return (
    <div
      class="interactive-map-canvas"
      classList={{
        "interactive-map-canvas-modal": props.variant === "modal",
        "interactive-map-canvas-page": props.variant === "page",
      }}
      ref={wrapper}
    >
      <div class="interactive-map-stage" ref={stage}>
        <div class="interactive-map-inner">
          <img
            id={props.imageId}
            class="interactive-map-image"
            ref={image}
            src={props.imageSrc}
            draggable={false}
            alt={props.alt}
          />
          <div class="map-pins-overlay">
            <For each={props.pins ?? []}>
              {(pin) => (
                <>
                  {props.onActivatePin === undefined ? (
                    <img
                      class="map-pin map-pin-marker"
                      classList={{ obtained: pin.isObtained === true }}
                      style={{
                        left: `${pin.x * 100}%`,
                        top: `${pin.y * 100}%`,
                      }}
                      src={pin.iconSrc}
                      alt=""
                      aria-label={pin.label}
                      draggable={false}
                    />
                  ) : (
                    <button
                      type="button"
                      class="map-pin"
                      classList={{ obtained: pin.isObtained === true }}
                      style={{
                        left: `${pin.x * 100}%`,
                        top: `${pin.y * 100}%`,
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onActivatePin?.(pin);
                      }}
                      aria-label={pin.label}
                    >
                      <img src={pin.iconSrc} alt="" draggable={false} />
                    </button>
                  )}
                </>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
