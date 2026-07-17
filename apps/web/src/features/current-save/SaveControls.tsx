import { createSignal } from "solid-js";

import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import { UploadModal } from "./UploadModal.tsx";

export function SaveControls() {
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const [isUploadOpen, setIsUploadOpen] = createSignal(false);

  return (
    <>
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
      <UploadModal
        isOpen={isUploadOpen()}
        onClose={() => {
          setIsUploadOpen(false);
        }}
      />
    </>
  );
}
