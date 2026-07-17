import { Show } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
import type { InteractiveMapPin } from "../map/InteractiveMapCanvas.tsx";
import { InteractiveMapCanvas } from "../map/InteractiveMapCanvas.tsx";
import { resolveMapImageSrc } from "../map/map-selectors.ts";
import styles from "./InfoModal.module.css";
import type { ProgressItemData } from "./progress-types.ts";

interface InfoModalProps {
  readonly item: ProgressItemData | undefined;
  readonly onClose: () => void;
}

export function InfoModal(props: InfoModalProps) {
  return (
    <Show when={props.item}>
      {(item) => (
        <div
          id="info-overlay"
          class={styles["overlay"]}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              props.onClose();
            }
          }}
        >
          <div id="info-content" class={styles["panel"]}>
            <button
              id="closeInfoModal"
              aria-label="Close item details"
              class={styles["close"]}
              type="button"
              onClick={props.onClose}
            >
              X
            </button>
            <img
              src={resolveIconSrc(item().icon)}
              alt={item().label}
              class={styles["image"]}
            />
            <h2 class={styles["title"]}>{item().label}</h2>
            <p class={styles["description"]}>{item().description}</p>
            <Show
              when={
                item().type === "journal"
                && typeof item().hornetDescription === "string"
                && item().hornetDescription?.trim() !== ""
              }
            >
              <img
                src={assetUrl("assets/ui/divider_journal.png")}
                alt="divider"
                class={styles["journalDivider"]}
              />
              <p class={styles["hornetDescription"]}>
                {item().hornetDescription}
              </p>
            </Show>
            <Show when={item().obtain !== undefined}>
              <p class={styles["extra"]}>
                <strong>Obtained:</strong> {item().obtain}
              </p>
            </Show>
            <Show when={item().cost !== undefined}>
              <p class={styles["extra"]}>
                <strong>Cost:</strong> {item().cost}
              </p>
            </Show>
            <Show when={item().use !== undefined}>
              <p class={styles["extra"]}>
                <strong>Use:</strong> {item().use}
              </p>
            </Show>
            <Show when={item().mapViewer}>
              {(mapViewer) => (
                <div class={styles["mapWrapper"]}>
                  <InteractiveMapCanvas
                    alt={`${item().label} map location`}
                    focus={{
                      x: mapViewer().x,
                      y: mapViewer().y,
                      zoom: mapViewer().zoom,
                    }}
                    imageSrc={resolveMapImageSrc(mapViewer().src)}
                    pins={getInfoMapPins(item())}
                    variant="modal"
                  />
                </div>
              )}
            </Show>
            <Show when={typeof item().link === "string" && item().link !== ""}>
              <div class={styles["linkWrapper"]}>
                <a
                  href={item().link}
                  target="_blank"
                  rel="noreferrer"
                  class={styles["link"]}
                >
                  More info
                </a>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
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

function getInfoMapPins(
  item: ProgressItemData,
): ReadonlyArray<InteractiveMapPin<ProgressItemData>> {
  const { mapViewer } = item;
  if (mapViewer === undefined || item.showOnMap !== true) {
    return [];
  }

  return [
    {
      iconSrc: resolveIconSrc(item.icon),
      id: item.id,
      label: item.label,
      payload: item,
      x: mapViewer.x,
      y: mapViewer.y,
    },
  ];
}
