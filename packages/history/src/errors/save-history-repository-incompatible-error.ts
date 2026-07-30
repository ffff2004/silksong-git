import type {
  SaveHistoryRepositoryCapability,
  SaveHistoryRepositoryRequiredAction,
  SaveHistoryRepositoryStatus,
} from "../types.ts";

export class SaveHistoryRepositoryIncompatibleError extends Error {
  readonly status: Exclude<SaveHistoryRepositoryStatus, "ready">;
  readonly requiredAction: Exclude<SaveHistoryRepositoryRequiredAction, "open">;
  readonly capabilities: readonly SaveHistoryRepositoryCapability[];

  constructor(
    input: {
      readonly status: Exclude<SaveHistoryRepositoryStatus, "ready">;
      readonly requiredAction: Exclude<
        SaveHistoryRepositoryRequiredAction,
        "open"
      >;
      readonly capabilities: readonly SaveHistoryRepositoryCapability[];
    },
    options?: ErrorOptions,
  ) {
    super(
      "The Save History Repository is not ready for this operation.",
      options,
    );
    this.name = "SaveHistoryRepositoryIncompatibleError";
    this.status = input.status;
    this.requiredAction = input.requiredAction;
    this.capabilities = input.capabilities;
  }
}
