interface WatchLockInfo {
  readonly pid?: unknown;
  readonly startedAt?: unknown;
  readonly repoPath?: unknown;
  readonly watchedSavePath?: unknown;
  readonly command?: unknown;
}

export class LocalHistoryApiProcessAlreadyRunningError extends Error {
  override name = "LocalHistoryApiProcessAlreadyRunningError";

  readonly lockPath: string;
  readonly lockInfo?: WatchLockInfo;

  constructor(
    input: { readonly lockPath: string; readonly lockInfo?: WatchLockInfo },
    options?: ErrorOptions,
  ) {
    super(
      "Local History API Process is already running for this Save History Repository.",
      options,
    );
    this.lockPath = input.lockPath;
    this.lockInfo = input.lockInfo;
  }
}
