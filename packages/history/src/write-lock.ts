import type { FileHandle } from "node:fs/promises";
import { open, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { SaveHistoryRepositoryBusyError } from "./errors.ts";
import { getRepositoryLayout } from "./layout.ts";

const defaultLockTimeoutMs = 5000;
const lockRetryDelayMs = 25;

export async function withHistoryWriteLock<T>(
  repoPath: string,
  writeOperation: () => Promise<T>,
): Promise<T> {
  const lockPath = getRepositoryLayout(repoPath).writeLockPath;
  const lock = await acquireLock(lockPath);

  try {
    return await writeOperation();
  } finally {
    await releaseLock(lock, lockPath);
  }
}

async function acquireLock(
  lockPath: string,
  deadline = Date.now() + defaultLockTimeoutMs,
): Promise<FileHandle> {
  try {
    return await createLock(lockPath);
  } catch (error) {
    if (!isExistingLockError(error) || Date.now() >= deadline) {
      throw new SaveHistoryRepositoryBusyError({ cause: error });
    }

    await sleep(lockRetryDelayMs);

    return await acquireLock(lockPath, deadline);
  }
}

async function createLock(lockPath: string): Promise<FileHandle> {
  const handle = await open(lockPath, "wx");

  try {
    await handle.writeFile(createLockContents());

    return handle;
  } catch (error) {
    await releaseLock(handle, lockPath);

    throw error;
  }
}

async function releaseLock(handle: FileHandle, lockPath: string) {
  try {
    await handle.close();
  } finally {
    await rm(lockPath, { force: true });
  }
}

function createLockContents(): string {
  const startedAt = new Date();

  return `${JSON.stringify(
    {
      pid: process.pid,
      startedAt: startedAt.toISOString(),
    },
    undefined,
    2,
  )}\n`;
}

function isExistingLockError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
