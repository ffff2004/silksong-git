import type * as monaco from "monaco-editor";
import { createEffect, onCleanup, onMount } from "solid-js";

import { loadMonaco } from "./load-monaco.ts";
import styles from "./MonacoViewer.module.css";

interface MonacoJsonViewerProps {
  readonly value: string;
}

export function MonacoJsonViewer(props: MonacoJsonViewerProps) {
  let container: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let isDisposed = false;

  onMount(() => {
    if (import.meta.env.MODE === "test") {
      return;
    }

    loadMonaco().then(
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
          language: "json",
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
    editor?.dispose();
  });

  return (
    <>
      <div class={styles["frame"]}>
        <div
          ref={container}
          id="raw-save-data-output"
          class={styles["editor"]}
          style={{
            display: import.meta.env.MODE === "test" ? "none" : undefined,
          }}
        />
      </div>
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
