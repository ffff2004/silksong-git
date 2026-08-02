import { useNavigate } from "@solidjs/router";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { useRuntimeCapabilities } from "../../state/runtime-capabilities.tsx";
import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import { applyStaticSaveResult } from "./static-save-result.ts";
import { UploadModal } from "./UploadModal.tsx";

export function SaveControls() {
  const runtimeCapabilities = useRuntimeCapabilities();
  const localHistory = useLocalHistoryStore();
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const navigate = useNavigate();
  const [isUploadOpen, setIsUploadOpen] = createSignal(false);

  const handleNativeSaveResult = (
    result: Parameters<typeof applyStaticSaveResult>[0],
  ) => {
    applyStaticSaveResult(result, {
      disconnectLocalHistory: localHistory.disconnect,
      loadDecodedSave: saveStore.loadDecodedSave,
      navigateToProgress: () => {
        navigate("/progress");
      },
      reportFailure: toastStore.showToast,
      reportSuccess: () => {
        toastStore.showToast("Local save loaded successfully!");
      },
    });
  };

  onMount(() => {
    if (
      runtimeCapabilities.kind !== "desktop"
      || runtimeCapabilities.onStaticEncodedSavePicked === undefined
    ) {
      return;
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    runtimeCapabilities
      .onStaticEncodedSavePicked((result) => {
        if (active) {
          handleNativeSaveResult(result);
        }
      })
      .then((nextUnlisten) => {
        if (active) {
          unlisten = nextUnlisten;
        } else {
          nextUnlisten();
        }
      })
      .catch(() => undefined);
    onCleanup(() => {
      active = false;
      unlisten?.();
    });
  });

  return (
    <>
      <Show when={runtimeCapabilities.kind === "browser"}>
        <button
          id="upload-save"
          class={`${buttonStyles["primary"]} ${buttonStyles["compact"]}`}
          type="button"
          onClick={() => {
            setIsUploadOpen(true);
          }}
        >
          Upload save
        </button>
      </Show>
      <button
        id="clearDataBtn"
        class={buttonStyles["danger"]}
        type="button"
        title="Reset all data"
        onClick={() => {
          saveStore.clear();
          toastStore.showToast("Data cleared.");
        }}
      >
        <i class="fa-solid fa-trash-can" /> Reset
      </button>
      <Show when={runtimeCapabilities.kind === "browser"}>
        <UploadModal
          isOpen={isUploadOpen()}
          onClose={() => {
            setIsUploadOpen(false);
          }}
        />
      </Show>
    </>
  );
}
