import { Show } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
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
          class="overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              props.onClose();
            }
          }}
        >
          <div id="info-content" class="modal">
            <button
              id="closeInfoModal"
              class="modal-close"
              type="button"
              onClick={props.onClose}
            >
              X
            </button>
            <img
              src={resolveIconSrc(item().icon)}
              alt={item().label}
              class="info-image"
            />
            <h2 class="info-title">{item().label}</h2>
            <p class="info-description">{item().description}</p>
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
                class="journal-divider"
              />
              <p class="hornet-description">{item().hornetDescription}</p>
            </Show>
            <Show when={item().obtain !== undefined}>
              <p class="info-extra">
                <strong>Obtained:</strong> {item().obtain}
              </p>
            </Show>
            <Show when={item().cost !== undefined}>
              <p class="info-extra">
                <strong>Cost:</strong> {item().cost}
              </p>
            </Show>
            <Show when={item().use !== undefined}>
              <p class="info-extra">
                <strong>Use:</strong> {item().use}
              </p>
            </Show>
            <Show when={item().mapViewer}>
              {(mapViewer) => (
                <div class="info-map-wrapper">
                  <div class="custom-map-viewer">
                    <div class="custom-map-inner">
                      <img
                        src={resolveMapImageSrc(mapViewer().src)}
                        class="custom-map-image"
                        draggable={false}
                        loading="lazy"
                        alt=""
                      />
                      <Show when={item().showOnMap === true}>
                        <img
                          src={resolveIconSrc(item().icon)}
                          class="custom-map-pin"
                          style={{
                            left: `${mapViewer().x * 100}%`,
                            top: `${mapViewer().y * 100}%`,
                          }}
                          alt=""
                          draggable={false}
                        />
                      </Show>
                    </div>
                  </div>
                </div>
              )}
            </Show>
            <Show when={typeof item().link === "string" && item().link !== ""}>
              <div class="info-link-wrapper">
                <a
                  href={item().link}
                  target="_blank"
                  rel="noreferrer"
                  class="info-link"
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

function resolveMapImageSrc(src: string): string {
  const clean = src.trim();
  if (clean.startsWith("http")) {
    return clean;
  }

  return assetUrl(clean);
}
