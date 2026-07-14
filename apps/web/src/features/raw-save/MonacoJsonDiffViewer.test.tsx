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
  const cancel = vi.fn();
  const dispose = vi.fn();
  const setModel = vi.fn((_model: DiffModelPair) => undefined);
  const createDiffEditor = vi.fn(() => ({ dispose, setModel }));
  const createModel = vi.fn((value: string, language: string) => ({
    dispose: vi.fn(),
    language,
    value,
  }));
  const initResult = Object.assign(
    Promise.resolve({ editor: { createDiffEditor, createModel } }),
    { cancel },
  );
  const init = vi.fn((): unknown => initResult);

  return { cancel, createDiffEditor, createModel, dispose, init, setModel };
});

vi.mock("@monaco-editor/loader", () => ({
  default: {
    init: monacoMock.init,
  },
}));

describe("MonacoJsonDiffViewer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("mounts the from and to JSON values as a Monaco diff model", async () => {
    vi.stubEnv("MODE", "production");

    render(() => (
      <MonacoJsonDiffViewer
        fromValue={'{"before":true}'}
        toValue={'{"after":true}'}
      />
    ));

    await waitFor(() => {
      expect(monacoMock.createDiffEditor).toHaveBeenCalledTimes(1);
    });

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
  });
});
