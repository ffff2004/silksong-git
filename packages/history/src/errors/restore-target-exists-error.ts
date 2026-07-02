export class RestoreTargetExistsError extends Error {
  override name = "RestoreTargetExistsError";

  readonly targetPath: string;

  constructor(targetPath: string, options?: ErrorOptions) {
    super(`Restore target already exists: ${targetPath}`, options);
    this.targetPath = targetPath;
  }
}
