export class InvalidRestoreBackupDirectoryError extends Error {
  override name = "InvalidRestoreBackupDirectoryError";

  readonly backupDirectory: string;

  constructor(
    input: {
      readonly backupDirectory: string;
      readonly reason: string;
    },
    options?: ErrorOptions,
  ) {
    super(`Invalid restore backup directory: ${input.reason}`, options);
    this.backupDirectory = input.backupDirectory;
  }
}
