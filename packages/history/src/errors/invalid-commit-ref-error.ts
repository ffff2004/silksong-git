export class InvalidCommitRefError extends Error {
  readonly ref: string;
  override name = "InvalidCommitRefError";

  constructor(ref: string, options?: ErrorOptions) {
    super(`Invalid commit ref: ${ref}`, options);
    this.ref = ref;
  }
}
