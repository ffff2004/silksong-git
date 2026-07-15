import loader from "@monaco-editor/loader";
import type * as monaco from "monaco-editor";
import { createEffect, onCleanup, onMount } from "solid-js";

import styles from "./MonacoViewer.module.css";

interface MonacoJsonDiffViewerProps {
  readonly fromValue: string;
  readonly toValue: string;
}

type MonacoInit = Promise<typeof monaco> & { cancel: () => void };

export function MonacoJsonDiffViewer(props: MonacoJsonDiffViewerProps) {
  let container: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneDiffEditor | undefined;
  let originalModel: monaco.editor.ITextModel | undefined;
  let modifiedModel: monaco.editor.ITextModel | undefined;
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

        editor = monacoInstance.editor.createDiffEditor(container, {
          contextmenu: true,
          folding: true,
          fontSize: 14,
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: true,
          renderSideBySide: true,
          wordWrap: "on",
        });
        originalModel = monacoInstance.editor.createModel(
          props.fromValue,
          "json",
        );
        modifiedModel = monacoInstance.editor.createModel(
          props.toValue,
          "json",
        );
        editor.setModel({
          modified: modifiedModel,
          original: originalModel,
        });
      },
      (error: unknown) => {
        if (isDisposed) {
          return;
        }

        console.error("Failed to initialize Monaco diff editor.", error);
      },
    );
  });

  createEffect(() => {
    const { fromValue } = props;
    const { toValue } = props;
    originalModel?.setValue(fromValue);
    modifiedModel?.setValue(toValue);
  });

  onCleanup(() => {
    isDisposed = true;
    monacoInit?.cancel();
    editor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
  });

  return (
    <>
      <div class={styles["frame"]} style={{ height: "calc(100vh - 18rem)" }}>
        <div
          ref={container}
          id="raw-save-diff-output"
          class={styles["editor"]}
          style={{
            display: import.meta.env.MODE === "test" ? "none" : undefined,
          }}
        />
      </div>
      <div
        data-testid="raw-save-diff-fallback"
        style={{
          display: import.meta.env.MODE === "test" ? undefined : "none",
        }}
      >
        <pre>{props.fromValue}</pre>
        <pre>{props.toValue}</pre>
      </div>
    </>
  );
}
