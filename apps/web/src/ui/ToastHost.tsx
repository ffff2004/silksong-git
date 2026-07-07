import { For } from "solid-js";

import { useToastStore } from "../state/toast-store.tsx";

export function ToastHost() {
  const toastStore = useToastStore();

  return (
    <div aria-live="polite">
      <For each={toastStore.messages()}>
        {(toast) => (
          <div
            style={{
              background: "#333",
              "border-radius": "6px",
              bottom: "20px",
              "box-shadow": "0 0 6px rgba(0,0,0,0.3)",
              color: "white",
              "font-size": "0.9rem",
              left: "50%",
              padding: "10px 18px",
              position: "fixed",
              transform: "translateX(-50%)",
              "z-index": 9999,
            }}
          >
            {toast.message}
          </div>
        )}
      </For>
    </div>
  );
}
