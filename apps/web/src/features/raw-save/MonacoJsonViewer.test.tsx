import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MonacoJsonViewer } from "./MonacoJsonViewer.tsx";

const monacoMock = vi.hoisted(() => {
  const dispose = vi.fn();
  const setValue = vi.fn();
  const create = vi.fn(() => ({ dispose, setValue }));
  const loadMonaco = vi.fn(
    async () => await Promise.resolve({ editor: { create } }),
  );

  return { create, dispose, loadMonaco, setValue };
});

vi.mock("./load-monaco.ts", () => ({
  loadMonaco: monacoMock.loadMonaco,
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

    const { unmount } = render(() => <TestHost />);

    await waitFor(() => {
      expect(monacoMock.create).toHaveBeenCalledTimes(1);
    });

    const container = document.querySelector("#raw-save-data-output");
    if (!(container instanceof HTMLDivElement)) {
      throw new TypeError("Expected the Monaco editor container.");
    }
    expect(monacoMock.create).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ language: "json" }),
    );

    monacoMock.setValue.mockClear();
    setViewerValue?.('{"second":true}');

    await waitFor(() => {
      expect(monacoMock.setValue).toHaveBeenCalledWith('{"second":true}');
    });

    unmount();
    expect(monacoMock.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not create an editor when unmounted before Monaco loads", async () => {
    vi.stubEnv("MODE", "production");

    const { promise: pendingLoad, resolve: resolveLoad } =
      Promise.withResolvers<{
        editor: { create: typeof monacoMock.create };
      }>();
    monacoMock.loadMonaco.mockReturnValueOnce(pendingLoad);

    const { unmount } = render(() => (
      <MonacoJsonViewer value={'{"pending":true}'} />
    ));
    unmount();

    resolveLoad({ editor: { create: monacoMock.create } });
    await pendingLoad;

    expect(monacoMock.create).not.toHaveBeenCalled();
  });
});
