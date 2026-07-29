import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api.js";

type MonacoApi = typeof Monaco;

export function createMonacoLoader(
  initialize: () => Promise<MonacoApi>,
): () => Promise<MonacoApi> {
  let monacoPromise: Promise<MonacoApi> | undefined;

  async function initializeWithRetry(): Promise<MonacoApi> {
    try {
      return await initialize();
    } catch (error: unknown) {
      monacoPromise = undefined;
      throw error;
    }
  }

  return async () => {
    monacoPromise ??= initializeWithRetry();
    return await monacoPromise;
  };
}

export const loadMonaco = createMonacoLoader(initializeMonaco);

async function initializeMonaco(): Promise<MonacoApi> {
  const [{ default: EditorWorker }, { default: JsonWorker }] =
    await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/language/json/json.worker?worker"),
    ]);

  const monacoEnvironment: NonNullable<typeof globalThis.MonacoEnvironment> = {
    getWorker: (_workerId, label) =>
      label === "json" ? new JsonWorker() : new EditorWorker(),
  };
  Object.assign(globalThis, { MonacoEnvironment: monacoEnvironment });

  const [monaco] = await Promise.all([
    import("monaco-editor/esm/vs/editor/editor.api.js"),
    import("monaco-editor/esm/vs/language/json/monaco.contribution.js"),
  ]);

  return monaco;
}
