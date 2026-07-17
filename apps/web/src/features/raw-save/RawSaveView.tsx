import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import viewStyles from "../../ui/View.module.css";
import { writeClipboardText } from "../../utils/clipboard.ts";
import { MonacoJsonViewer } from "./MonacoJsonViewer.tsx";
import { downloadRawSaveJson, getRawSaveJson } from "./raw-save-actions.ts";
import styles from "./RawSaveView.module.css";

export function RawSaveView() {
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const rawJson = () => getRawSaveJson(saveStore.decodedSave());
  const copyRawJson = () => {
    if (!saveStore.hasSave()) {
      toastStore.showToast("No save loaded yet.");
      return;
    }

    writeClipboardText(rawJson()).then(
      () => {
        toastStore.showToast("JSON copied to clipboard.");
      },
      () => {
        toastStore.showToast("Copy failed.");
      },
    );
  };
  const downloadRawJson = () => {
    if (!saveStore.hasSave()) {
      toastStore.showToast("No save loaded yet.");
      return;
    }

    downloadRawSaveJson(saveStore.decodedSave());
  };

  return (
    <section
      id="rawsave-section"
      class={viewStyles["view"]}
      data-testid="raw-save-view"
      aria-labelledby="raw-save-title"
    >
      <div class={styles["container"]}>
        <div class={styles["header"]}>
          <h2 id="raw-save-title">Raw Save Data</h2>
          <div class={styles["actions"]}>
            <button
              id="raw-save-data-copy"
              class={styles["button"]}
              type="button"
              onClick={copyRawJson}
            >
              Copy
            </button>
            <button
              id="raw-save-json-data-download"
              class={styles["button"]}
              type="button"
              onClick={downloadRawJson}
            >
              Download JSON
            </button>
          </div>
        </div>
        <MonacoJsonViewer value={rawJson()} />
      </div>
    </section>
  );
}
