export class RestoreWriteVerificationError extends Error {
  override name = "RestoreWriteVerificationError";

  readonly targetPath: string;
  readonly backupPath: string | undefined;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(
    input: {
      readonly targetPath: string;
      readonly backupPath: string | undefined;
      readonly expectedSha256: string;
      readonly actualSha256: string;
    },
    options?: ErrorOptions,
  ) {
    super(`Restore target verification failed: ${input.targetPath}`, options);
    this.targetPath = input.targetPath;
    this.backupPath = input.backupPath;
    this.expectedSha256 = input.expectedSha256;
    this.actualSha256 = input.actualSha256;
  }
}
