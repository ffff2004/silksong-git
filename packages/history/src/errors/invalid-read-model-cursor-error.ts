export class InvalidReadModelCursorError extends Error {
  override name = "InvalidReadModelCursorError";

  constructor(options?: ErrorOptions) {
    super("Invalid read-model cursor.", options);
  }
}
