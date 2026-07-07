import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MonacoJsonViewer } from "./MonacoJsonViewer.tsx";

const monacoMock = vi.hoisted(() => {
  const cancel = vi.fn();
  const dispose = vi.fn();
  const setValue = vi.fn();
  const create = vi.fn(() => ({ dispose, setValue }));
  const initResult = Object.assign(Promise.resolve({ editor: { create } }), {
    cancel,
  });
  const init = vi.fn((): unknown => initResult);

  return { cancel, create, dispose, init, setValue };
});

vi.mock("@monaco-editor/loader", () => ({
  default: {
    init: monacoMock.init,
  },
}));

describe("MonacoJsonViewer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("updates the mounted editor when the JSON value changes", async () => {
    vi.stubEnv("MODE", "production");

    let setViewerValue: ((nextValue: string) => void) | undefined;

    function TestHost() {
      const [value, setValue] = createSignal('{"first":true}');
      setViewerValue = (nextValue) => {
        setValue(nextValue);
      };

      return <MonacoJsonViewer value={value()} />;
    }

    render(() => <TestHost />);

    await waitFor(() => {
      expect(monacoMock.create).toHaveBeenCalledTimes(1);
    });

    monacoMock.setValue.mockClear();
    setViewerValue?.('{"second":true}');

    await waitFor(() => {
      expect(monacoMock.setValue).toHaveBeenCalledWith('{"second":true}');
    });
  });
});
