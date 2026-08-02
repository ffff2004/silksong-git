import type { PickStaticEncodedSaveResult } from "../../runtime-capabilities/interface.ts";

export function applyStaticSaveResult(
  result: PickStaticEncodedSaveResult,
  actions: {
    readonly disconnectLocalHistory: () => void;
    readonly loadDecodedSave: (
      decodedSave: unknown,
    ) =>
      | { readonly ok: true }
      | { readonly message: string; readonly ok: false };
    readonly navigateToProgress: () => void;
    readonly reportFailure: (message: string) => void;
    readonly reportSuccess: () => void;
  },
) {
  switch (result.kind) {
    case "cancelled": {
      return;
    }

    case "failed": {
      actions.reportFailure(result.message);
      return;
    }

    case "invalidFile": {
      actions.reportFailure("Choose an existing readable save file.");
      return;
    }

    case "decodeFailed": {
      actions.reportFailure("Invalid or corrupted Encoded Save.");
      return;
    }

    case "loaded": {
      const loaded = actions.loadDecodedSave(result.decodedSave);
      if (!loaded.ok) {
        actions.reportFailure(loaded.message);
        return;
      }
      // Disconnecting only drops the Web local HTTP client. Rust keeps its Repo Session alive,
      // while the displayed source becomes Static.
      actions.disconnectLocalHistory();
      actions.navigateToProgress();
      actions.reportSuccess();
      break;
    }
  }
}
