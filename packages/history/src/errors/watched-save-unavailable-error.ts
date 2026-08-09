export class WatchedSaveUnavailableError extends Error {
  override name = "WatchedSaveUnavailableError";

  readonly watchedSavePath: string;

  constructor(watchedSavePath: string, options?: ErrorOptions) {
    super(`Watched Save is unavailable: ${watchedSavePath}`, options);
    this.watchedSavePath = watchedSavePath;
  }
}
