import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import { writeClipboardText } from "../../utils/clipboard.ts";
import { MonacoJsonViewer } from "./MonacoJsonViewer.tsx";
import { downloadRawSaveJson, getRawSaveJson } from "./raw-save-actions.ts";

export function RawSaveView() {
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const rawJson = () => getRawSaveJson(saveStore.decodedSave());

  return (
    <section id="rawsave-section" class="tab" data-testid="raw-save-view">
      <div class="rawsave-container">
        <div class="rawsave-header">
          <h2>Raw Save Data</h2>
          <div class="rawsave-actions">
            <button
              id="raw-save-data-copy"
              class="rawsave-btn"
              type="button"
              onClick={() => {
                if (!saveStore.hasSave()) {
                  toastStore.showToast("No save loaded yet.");
                  return;
                }

                void writeClipboardText(rawJson())
                  .then(() => {
                    toastStore.showToast("JSON copied to clipboard.");
                  })
                  .catch(() => {
                    toastStore.showToast("Copy failed.");
                  });
              }}
            >
              Copy
            </button>
            <button
              id="raw-save-json-data-download"
              class="rawsave-btn"
              type="button"
              onClick={() => {
                if (!saveStore.hasSave()) {
                  toastStore.showToast("No save loaded yet.");
                  return;
                }

                downloadRawSaveJson(saveStore.decodedSave());
              }}
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
