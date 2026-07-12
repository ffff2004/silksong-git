export class RestoreConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("The Watched Save no longer matches the confirmed state.", options);
    this.name = "RestoreConflictError";
  }
}
