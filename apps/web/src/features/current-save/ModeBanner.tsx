import { Show } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
import { useSaveStore } from "../../state/save-store.tsx";

export function ModeBanner() {
  const saveStore = useSaveStore();
  const isSteelSoul = () => saveStore.mode() === "steel";

  return (
    <div
      id="modeBanner"
      classList={{ hidden: !saveStore.hasSave(), steel: isSteelSoul() }}
    >
      <Show when={saveStore.hasSave()}>
        <Show when={isSteelSoul()} fallback="NORMAL SAVE LOADED">
          <img
            src={assetUrl("assets/icons/Steel_Soul_Icon.png")}
            alt="Steel Soul"
            class="mode-icon"
          />{" "}
          STEEL SOUL SAVE LOADED
        </Show>
      </Show>
    </div>
  );
}
