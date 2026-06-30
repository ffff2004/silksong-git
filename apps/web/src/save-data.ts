import type {
  ParsedDecodedSave,
  SemanticSnapshotItem,
} from "@silksong-git/core";
import {
  UnrecognizedSaveSchemaError,
  createSemanticSnapshot,
  decodeEncodedSave,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { BASE_PATH } from "./constants.ts";
import {
  completionValue,
  modeBanner,
  playtimeValue,
  rosariesValue,
  shardsValue,
  uploadOverlay,
} from "./elements.ts";
import { renderActiveTab } from "./render-tab.ts";
import type { Mode } from "./types/Mode";
import { showToast } from "./utils.ts";

let currentLoadedSaveData: unknown;
let currentLoadedSaveDataMode: Mode = "normal";
let currentLoadedSemanticItems = new Map<string, SemanticSnapshotItem>();

export function getSaveData(): unknown {
  return currentLoadedSaveData;
}

export function getSaveDataMode(): Mode {
  return currentLoadedSaveDataMode;
}

export function getSemanticSnapshotItem(
  itemId: string,
): SemanticSnapshotItem | undefined {
  return currentLoadedSemanticItems.get(itemId);
}

export async function handleSaveFile(file: File | undefined): Promise<void> {
  try {
    if (file === undefined) {
      showToast("No file selected.");
      uploadOverlay.classList.remove("hidden");
      return;
    }

    const scrollContainer = document.querySelector("main");
    const currentScroll = scrollContainer ? scrollContainer.scrollTop : 0;

    const buffer = await file.arrayBuffer();
    const isJSON = file.name.toLowerCase().endsWith(".json");

    const decodedSave: unknown = isJSON
      ? JSON.parse(new TextDecoder("utf8").decode(buffer))
      : decodeEncodedSave(buffer).decodedSave;

    let parsedSave: ParsedDecodedSave;
    try {
      parsedSave = parseDecodedSave(decodedSave);
    } catch (error) {
      if (error instanceof UnrecognizedSaveSchemaError) {
        console.error("[save] Parse error:", error);
        showToast("Invalid or corrupted save file");
        uploadOverlay.classList.remove("hidden");
        return;
      }

      throw error;
    }

    const snapshot = createSemanticSnapshot(
      parsedSave,
      getBuiltinMappingData(),
    );

    currentLoadedSaveData = decodedSave;
    currentLoadedSemanticItems = new Map(
      snapshot.items.map((item) => [item.id, item]),
    );

    completionValue.textContent = `${snapshot.summary.completionPercentage ?? 0}%`;
    const seconds = snapshot.summary.playTime ?? 0;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    playtimeValue.textContent = `${hours}h ${mins}m`;
    rosariesValue.textContent = (snapshot.summary.rosaries ?? 0).toString();
    shardsValue.textContent = (snapshot.summary.shellShards ?? 0).toString();

    const isSteelSoul = (
      [1, 2, 3, "On", "Dead"] as Array<string | number | undefined>
    ).includes(snapshot.summary.permadeathMode as string | number | undefined);
    currentLoadedSaveDataMode = isSteelSoul ? "steel" : "normal";

    modeBanner.innerHTML = isSteelSoul
      ? `<img src="${BASE_PATH}/assets/icons/Steel_Soul_Icon.png" alt="Steel Soul" class="mode-icon"> STEEL SOUL SAVE LOADED`
      : "NORMAL SAVE LOADED";
    modeBanner.classList.remove("hidden");
    modeBanner.classList.toggle("steel", isSteelSoul);

    renderActiveTab();
    globalThis.dispatchEvent(new Event("save-data-changed"));

    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = currentScroll;
      });
    }

    showToast("Save file loaded successfully!");
    uploadOverlay.classList.add("hidden");
  } catch (error) {
    console.error("[save] Decode error:", error);
    showToast("Error processing save file.");
    uploadOverlay.classList.remove("hidden");
  }
}

export function clearAllData(): void {
  currentLoadedSaveData = undefined;
  currentLoadedSemanticItems = new Map();
  currentLoadedSaveDataMode = "normal";

  const cleanUrl = globalThis.location.origin + globalThis.location.pathname;
  globalThis.history.pushState({}, "", cleanUrl);

  modeBanner.classList.add("hidden");
  modeBanner.innerHTML = "";
  completionValue.textContent = "0%";
  playtimeValue.textContent = "0h 00m";
  rosariesValue.textContent = "0";
  shardsValue.textContent = "0";

  const fileInput = document.querySelector<HTMLInputElement>("#fileInput");
  if (fileInput) {
    fileInput.value = "";
  }

  globalThis.dispatchEvent(new Event("save-data-changed"));

  try {
    renderActiveTab();
  } catch (error) {
    console.warn("Reset render executed on current tab", error);
  }

  showToast("Data cleared.");
}
