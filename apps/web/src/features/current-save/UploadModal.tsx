import { createSignal, Show } from "solid-js";

import { useSaveStore } from "../../state/save-store.tsx";
import { useToastStore } from "../../state/toast-store.tsx";
import { writeClipboardText } from "../../utils/clipboard.ts";

interface UploadModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

export function UploadModal(props: UploadModalProps) {
  let fileInput: HTMLInputElement | undefined;
  const saveStore = useSaveStore();
  const toastStore = useToastStore();
  const [isDragOver, setIsDragOver] = createSignal(false);

  const uploadFile = async (file: File | undefined) => {
    const result = await saveStore.loadFile(file);
    if (result.ok) {
      toastStore.showToast("Save file loaded successfully!");
      props.onClose();
      return;
    }

    toastStore.showToast(result.message);
  };

  const startUpload = (file: File | undefined) => {
    uploadFile(file).catch(() => {
      toastStore.showToast("Unable to load save file.");
    });
  };

  const copyPath = (path: string) => {
    writeClipboardText(path).then(
      () => {
        toastStore.showToast("Path copied to clipboard!");
      },
      () => {
        toastStore.showToast("Unable to copy path.");
      },
    );
  };

  const openFilePicker = () => {
    fileInput?.click();
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    startUpload(event.dataTransfer?.files[0]);
  };

  return (
    <Show when={props.isOpen}>
      <div
        id="uploadOverlay"
        class="overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uploadTitle"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            props.onClose();
          }
        }}
      >
        <div class="modal">
          <div class="modal-header">
            <h3 id="uploadTitle">Upload your save file</h3>
            <button
              class="modal-close"
              id="closeUploadModal"
              type="button"
              aria-label="Close"
              onClick={props.onClose}
            >
              X
            </button>
          </div>

          <div
            id="dropzone"
            class="dropzone"
            classList={{ dragover: isDragOver() }}
            tabindex="0"
            onClick={openFilePicker}
            onKeyDown={(event) => {
              if (!(event.key === "Enter" || event.key === " ")) {
                return;
              }

              event.preventDefault();
              openFilePicker();
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsDragOver(false);
            }}
            onDrop={handleDrop}
          >
            <p>Drag and drop your save file here, or click to browse!</p>
            <p>Choose the correct save file: user*.dat (e.g. user1.dat)</p>
          </div>

          <input
            ref={fileInput}
            type="file"
            id="fileInput"
            hidden
            onChange={(event) => {
              startUpload(event.currentTarget.files?.[0]);
            }}
          />

          <div class="help">
            <h4>Need help finding your save?</h4>
            <p class="muted">What do you play on?</p>
            <div class="platforms">
              <PathPill
                label="Mac"
                path="~/Library/Application Support/unity.Team-Cherry.Silksong"
              />
              <PathPill
                label="Windows"
                path={String.raw`%USERPROFILE%\AppData\LocalLow\Team Cherry\Hollow Knight Silksong`}
              />
              <PathPill
                label="Linux"
                path="~/.config/unity3d/Team Cherry/Hollow Knight Silksong"
              />
              <a
                class="pill"
                href="https://store.steampowered.com/account/remotestorageapp/?appid=1030300"
                target="_blank"
                rel="noreferrer"
              >
                Steam Cloud
              </a>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );

  function PathPill(pillProps: {
    readonly label: string;
    readonly path: string;
  }) {
    return (
      <button
        class="pill"
        type="button"
        onClick={() => {
          copyPath(pillProps.path);
        }}
      >
        {pillProps.label}
      </button>
    );
  }
}
