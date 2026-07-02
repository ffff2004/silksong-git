export class RestoreBackupFailedError extends Error {
  override name = "RestoreBackupFailedError";

  readonly targetPath: string;
  readonly backupDirectory: string;

  constructor(
    input: {
      readonly targetPath: string;
      readonly backupDirectory: string;
    },
    options?: ErrorOptions,
  ) {
    super(`Failed to back up restore target: ${input.targetPath}`, options);
    this.targetPath = input.targetPath;
    this.backupDirectory = input.backupDirectory;
  }
}
