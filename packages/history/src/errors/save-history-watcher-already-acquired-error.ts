interface WatchLockInfo {
  readonly pid?: unknown;
  readonly startedAt?: unknown;
  readonly repoPath?: unknown;
  readonly watchedSavePath?: unknown;
  readonly command?: unknown;
}

export class SaveHistoryWatcherAlreadyAcquiredError extends Error {
  override name = "SaveHistoryWatcherAlreadyAcquiredError";

  readonly lockPath: string;
  readonly lockInfo?: WatchLockInfo;

  constructor(
    input: { readonly lockPath: string; readonly lockInfo?: WatchLockInfo },
    options?: ErrorOptions,
  ) {
    super(
      "Local History Watch Process is already running for this Save History Repository.",
      options,
    );
    this.lockPath = input.lockPath;
    this.lockInfo = input.lockInfo;
  }
}
