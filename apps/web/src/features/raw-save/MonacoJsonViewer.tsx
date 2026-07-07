import loader from "@monaco-editor/loader";
import type * as monaco from "monaco-editor";
import { createEffect, onCleanup, onMount } from "solid-js";

interface MonacoJsonViewerProps {
  readonly value: string;
}

type MonacoInit = Promise<typeof monaco> & { cancel: () => void };

export function MonacoJsonViewer(props: MonacoJsonViewerProps) {
  let container: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let isDisposed = false;
  let monacoInit: { cancel: () => void } | undefined;

  onMount(() => {
    if (import.meta.env.MODE === "test") {
      return;
    }

    const monacoReady = loader.init() as MonacoInit;
    monacoInit = monacoReady;
    monacoReady.then(
      (monacoInstance) => {
        if (isDisposed || container === undefined) {
          return;
        }

        editor = monacoInstance.editor.create(container, {
          bracketPairColorization: { enabled: true },
          contextmenu: true,
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: "never",
            seedSearchStringFromSelection: "always",
          },
          folding: true,
          foldingHighlight: true,
          fontSize: 14,
          language: "javascript",
          lineNumbers: "on",
          matchBrackets: "always",
          minimap: { enabled: false },
          readOnly: true,
          renderWhitespace: "selection",
          showFoldingControls: "always",
          theme: "vs-dark",
          value: props.value,
          wordWrap: "on",
        });
      },
      (error: unknown) => {
        if (isDisposed) {
          return;
        }

        console.error("Failed to initialize Monaco editor.", error);
      },
    );
  });

  createEffect(() => {
    const { value } = props;
    editor?.setValue(value);
  });

  onCleanup(() => {
    isDisposed = true;
    monacoInit?.cancel();
    editor?.dispose();
  });

  return (
    <>
      <div
        ref={container}
        id="raw-save-data-output"
        style={{
          display: import.meta.env.MODE === "test" ? "none" : undefined,
        }}
      />
      <pre
        data-testid="raw-save-fallback"
        style={{
          display: import.meta.env.MODE === "test" ? undefined : "none",
        }}
      >
        {props.value}
      </pre>
    </>
  );
}
