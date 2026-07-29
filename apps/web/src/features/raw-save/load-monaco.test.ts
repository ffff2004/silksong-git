import { beforeEach, describe, expect, it, vi } from "vitest";

const monacoModules = vi.hoisted(() => {
  class EditorWorker {
    readonly kind = "editor";
  }
  class JsonWorker {
    readonly kind = "json";
  }

  return {
    editorApi: { editor: {} },
    editorApiLoads: 0,
    EditorWorker,
    environmentAtEditorApiLoad: undefined as
      | typeof globalThis.MonacoEnvironment
      | undefined,
    JsonWorker,
  };
});

vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: monacoModules.EditorWorker,
}));

vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: monacoModules.JsonWorker,
}));

vi.mock("monaco-editor/esm/vs/editor/editor.api.js", () => {
  monacoModules.editorApiLoads++;
  monacoModules.environmentAtEditorApiLoad = globalThis.MonacoEnvironment;

  return monacoModules.editorApi;
});

vi.mock(
  "monaco-editor/esm/vs/language/json/monaco.contribution.js",
  () => ({}),
);

describe("loadMonaco", () => {
  beforeEach(() => {
    vi.resetModules();
    monacoModules.editorApiLoads = 0;
    monacoModules.environmentAtEditorApiLoad = undefined;
    globalThis.MonacoEnvironment = undefined;
  });

  it("caches a successful initialization and configures local workers first", async () => {
    const { loadMonaco } = await import("./load-monaco.ts");

    const firstLoad = loadMonaco();
    const secondLoad = loadMonaco();

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
      expect.objectContaining({ editor: monacoModules.editorApi.editor }),
      expect.objectContaining({ editor: monacoModules.editorApi.editor }),
    ]);
    expect(monacoModules.editorApiLoads).toBe(1);
    expect(monacoModules.environmentAtEditorApiLoad).toBeDefined();

    const getWorker = monacoModules.environmentAtEditorApiLoad?.getWorker?.bind(
      monacoModules.environmentAtEditorApiLoad,
    );
    expect(getWorker).toBeDefined();
    expect(getWorker?.("worker-id", "json")).toBeInstanceOf(
      monacoModules.JsonWorker,
    );
    expect(getWorker?.("worker-id", "editorWorkerService")).toBeInstanceOf(
      monacoModules.EditorWorker,
    );
  });

  it("retries initialization after a failure", async () => {
    const { createMonacoLoader } = await import("./load-monaco.ts");
    const initialize = vi
      .fn(async () => monacoModules.editorApi as never)
      .mockRejectedValueOnce(new Error("editor API failed to load"));
    const loadMonaco = createMonacoLoader(initialize);

    await expect(loadMonaco()).rejects.toThrow("editor API failed to load");
    await expect(loadMonaco()).resolves.toBe(monacoModules.editorApi);
    await expect(loadMonaco()).resolves.toBe(monacoModules.editorApi);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
