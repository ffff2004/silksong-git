export class RepoSessionHttpServerStartError extends Error {
  override name = "RepoSessionHttpServerStartError";

  constructor(options?: ErrorOptions) {
    super("Local HTTP Adapter could not start.", options);
  }
}
