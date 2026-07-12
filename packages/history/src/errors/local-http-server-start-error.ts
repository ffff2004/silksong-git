export class LocalHttpServerStartError extends Error {
  override name = "LocalHttpServerStartError";

  constructor(options?: ErrorOptions) {
    super("Local HTTP Adapter could not start.", options);
  }
}
