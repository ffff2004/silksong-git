import type { FileHandle } from "node:fs/promises";
import { open, readFile, rm } from "node:fs/promises";

import { SaveHistoryWatcherAlreadyAcquiredError } from "./errors.ts";
import { getRepositoryLayout } from "./layout.ts";

interface AcquireWatchLockInput {
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly now: Date;
}

interface AcquireRepositoryWatchExclusionInput {
  readonly repoPath: string;
  readonly now?: Date;
}

interface WatchLock {
  readonly lockPath: string;
  release: () => Promise<void>;
}

export async function acquireWatchLock(
  input: AcquireWatchLockInput,
): Promise<WatchLock> {
  const lockPath = getRepositoryLayout(input.repoPath).watchLockPath;

  try {
    return await createWatchLockFile(input, lockPath);
  } catch (error) {
    if (isExistingLockError(error)) {
      throw new SaveHistoryWatcherAlreadyAcquiredError({
        lockPath,
        lockInfo: await readExistingLockInfo(lockPath),
      });
    }

    throw error;
  }
}

/** Internal repository-wide watcher exclusion for workflows that deliberately accept no config. */
export async function acquireRepositoryWatchExclusion(
  input: AcquireRepositoryWatchExclusionInput,
): Promise<WatchLock> {
  return await acquireWatchLock({
    repoPath: input.repoPath,
    watchedSavePath: "desktop-archive-move",
    now: input.now ?? new Date(),
  });
}

async function createWatchLockFile(
  input: AcquireWatchLockInput,
  lockPath: string,
): Promise<WatchLock> {
  const handle = await open(lockPath, "wx");

  await writeWatchLockContentsOrRelease(input, handle, lockPath);

  return createWatchLock(handle, lockPath);
}

async function writeWatchLockContentsOrRelease(
  input: AcquireWatchLockInput,
  handle: FileHandle,
  lockPath: string,
) {
  try {
    await handle.writeFile(createWatchLockContents(input));
  } catch (error) {
    await releaseLock(handle, lockPath);

    throw error;
  }
}

function createWatchLock(handle: FileHandle, lockPath: string): WatchLock {
  let released = false;

  return {
    lockPath,
    async release() {
      if (released) {
        return;
      }

      released = true;
      await releaseLock(handle, lockPath);
    },
  };
}

async function releaseLock(handle: FileHandle, lockPath: string) {
  try {
    await handle.close();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function createWatchLockContents(input: AcquireWatchLockInput): string {
  return `${JSON.stringify(
    {
      pid: process.pid,
      startedAt: input.now.toISOString(),
      repoPath: input.repoPath,
      watchedSavePath: input.watchedSavePath,
      command: process.argv.join(" "),
    },
    undefined,
    2,
  )}\n`;
}

async function readExistingLockInfo(lockPath: string) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function isExistingLockError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
