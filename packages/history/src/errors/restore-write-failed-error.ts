export class RestoreWriteFailedError extends Error {
  override name = "RestoreWriteFailedError";

  readonly targetPath: string;
  readonly backupPath: string | undefined;

  constructor(
    input: {
      readonly targetPath: string;
      readonly backupPath: string | undefined;
    },
    options?: ErrorOptions,
  ) {
    super(`Failed to write restore target: ${input.targetPath}`, options);
    this.targetPath = input.targetPath;
    this.backupPath = input.backupPath;
  }
}
