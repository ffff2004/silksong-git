import { describe, expect, it, vi } from "vitest";

import { applyStaticSaveResult } from "./static-save-result.ts";

function createActions() {
  return {
    disconnectLocalHistory: vi.fn(),
    loadDecodedSave: vi.fn(() => ({ ok: true as const })),
    navigateToProgress: vi.fn(),
    reportFailure: vi.fn(),
    reportSuccess: vi.fn(),
  };
}

describe("applyStaticSaveResult", () => {
  it("does not replace the current source when native selection is cancelled or fails", () => {
    const actions = createActions();

    applyStaticSaveResult({ kind: "cancelled" }, actions);
    applyStaticSaveResult({ kind: "invalidFile" }, actions);
    applyStaticSaveResult({ kind: "decodeFailed" }, actions);
    applyStaticSaveResult(
      { kind: "failed", message: "Unable to inspect local save." },
      actions,
    );

    expect(actions.loadDecodedSave).not.toHaveBeenCalled();
    expect(actions.disconnectLocalHistory).not.toHaveBeenCalled();
    expect(actions.navigateToProgress).not.toHaveBeenCalled();
    expect(actions.reportSuccess).not.toHaveBeenCalled();
    expect(actions.reportFailure).toHaveBeenCalledTimes(3);
  });
});
