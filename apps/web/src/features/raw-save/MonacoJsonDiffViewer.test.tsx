import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MonacoJsonDiffViewer } from "./MonacoJsonDiffViewer.tsx";

interface DiffModel {
  readonly value: string;
}

interface DiffModelPair {
  readonly modified: DiffModel;
  readonly original: DiffModel;
}

const monacoMock = vi.hoisted(() => {
  const dispose = vi.fn();
  const disposeModel = vi.fn();
  const setModel = vi.fn((_model: DiffModelPair) => undefined);
  const createDiffEditor = vi.fn(() => ({ dispose, setModel }));
  const createModel = vi.fn((value: string, language: string) => ({
    dispose: disposeModel,
    language,
    value,
  }));
  const loadMonaco = vi.fn(
    async () =>
      await Promise.resolve({ editor: { createDiffEditor, createModel } }),
  );

  return {
    createDiffEditor,
    createModel,
    dispose,
    disposeModel,
    loadMonaco,
    setModel,
  };
});

vi.mock("./load-monaco.ts", () => ({
  loadMonaco: monacoMock.loadMonaco,
}));

describe("MonacoJsonDiffViewer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("mounts the from and to JSON values as a Monaco diff model", async () => {
    vi.stubEnv("MODE", "production");

    const { unmount } = render(() => (
      <MonacoJsonDiffViewer
        fromValue={'{"before":true}'}
        toValue={'{"after":true}'}
      />
    ));

    await waitFor(() => {
      expect(monacoMock.createDiffEditor).toHaveBeenCalledTimes(1);
    });

    const container = document.querySelector("#raw-save-diff-output");
    if (!(container instanceof HTMLDivElement)) {
      throw new TypeError("Expected the Monaco Diff editor container.");
    }
    expect(container.parentElement?.style.height).toBe("calc(100vh - 18rem)");
    expect(monacoMock.createModel).toHaveBeenNthCalledWith(
      1,
      '{"before":true}',
      "json",
    );
    expect(monacoMock.createModel).toHaveBeenNthCalledWith(
      2,
      '{"after":true}',
      "json",
    );
    const model = monacoMock.setModel.mock.calls[0]?.[0];
    expect(model?.modified.value).toBe('{"after":true}');
    expect(model?.original.value).toBe('{"before":true}');

    unmount();
    expect(monacoMock.dispose).toHaveBeenCalledTimes(1);
    expect(monacoMock.disposeModel).toHaveBeenCalledTimes(2);
  });

  it("does not create an editor or models when unmounted before Monaco loads", async () => {
    vi.stubEnv("MODE", "production");

    const { promise: pendingLoad, resolve: resolveLoad } =
      Promise.withResolvers<{
        editor: {
          createDiffEditor: typeof monacoMock.createDiffEditor;
          createModel: typeof monacoMock.createModel;
        };
      }>();
    monacoMock.loadMonaco.mockReturnValueOnce(pendingLoad);

    const { unmount } = render(() => (
      <MonacoJsonDiffViewer
        fromValue={'{"before":true}'}
        toValue={'{"after":true}'}
      />
    ));
    unmount();

    resolveLoad({
      editor: {
        createDiffEditor: monacoMock.createDiffEditor,
        createModel: monacoMock.createModel,
      },
    });
    await pendingLoad;

    expect(monacoMock.createDiffEditor).not.toHaveBeenCalled();
    expect(monacoMock.createModel).not.toHaveBeenCalled();
  });
});
