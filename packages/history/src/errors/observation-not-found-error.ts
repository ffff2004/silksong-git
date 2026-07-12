export class ObservationNotFoundError extends Error {
  override name = "ObservationNotFoundError";

  constructor(options?: ErrorOptions) {
    super("Commit is not a Raw Save Observation.", options);
  }
}
