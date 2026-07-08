import type { JSX } from "solid-js";
import { createContext, createSignal, useContext } from "solid-js";

interface ToastMessage {
  readonly id: number;
  readonly message: string;
}

interface ToastStore {
  readonly messages: () => readonly ToastMessage[];
  readonly showToast: (message: string) => void;
}

const ToastContext = createContext<ToastStore>();

export function ToastProvider(props: { readonly children: JSX.Element }) {
  const [messages, setMessages] = createSignal<readonly ToastMessage[]>([]);
  let nextId = 1;

  const store: ToastStore = {
    messages,
    showToast(message) {
      const toast = { id: nextId, message };
      nextId++;
      setMessages((currentMessages) => [...currentMessages, toast]);
      setTimeout(() => {
        setMessages((currentMessages) =>
          currentMessages.filter(
            (currentMessage) => currentMessage.id !== toast.id,
          ),
        );
      }, 2500);
    },
  };

  return (
    <ToastContext.Provider value={store}>
      {props.children}
    </ToastContext.Provider>
  );
}

export function useToastStore(): ToastStore {
  const store = useContext(ToastContext);
  if (store === undefined) {
    throw new Error("Toast store is not available.");
  }

  return store;
}
