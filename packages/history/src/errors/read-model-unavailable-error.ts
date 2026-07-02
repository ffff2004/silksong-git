export class ReadModelUnavailableError extends Error {
  override name = "ReadModelUnavailableError";

  constructor(options?: ErrorOptions) {
    super("Semantic read model unavailable.", options);
  }
}
