export class SaveHistoryRepositoryBusyError extends Error {
  override name = "SaveHistoryRepositoryBusyError";

  constructor(options?: ErrorOptions) {
    super("Save History Repository is busy.", options);
  }
}
