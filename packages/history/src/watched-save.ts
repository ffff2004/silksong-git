import { readFile, stat } from "node:fs/promises";

import { parseProjectConfig, readProjectConfig } from "./config.ts";
import { WatchedSaveUnavailableError } from "./errors.ts";
import { getRepositoryLayout } from "./layout.ts";

export async function readWatchedSavePath(
  repoPath: string,
  access: "readOnly" | undefined,
): Promise<string> {
  if (access !== "readOnly") {
    const config = await readProjectConfig(repoPath);
    return config.watchedSavePath;
  }

  const config = parseProjectConfig(
    await readFile(getRepositoryLayout(repoPath).configPath, "utf8"),
  );
  if (
    config.status === "current"
    || config.status === "legacy"
    || config.status === "migrationRequired"
  ) {
    return config.config.watchedSavePath;
  }

  throw new Error("Save History Repository Project Config is not readable.");
}

export async function readWatchedSavePresence(
  repoPath: string,
  access: "readOnly" | undefined,
): Promise<"present" | "missing"> {
  const watchedSavePath = await readWatchedSavePath(repoPath, access);
  const fileStat = await readWatchedSaveStat(watchedSavePath);

  if (fileStat === undefined) {
    return "missing";
  }
  if (!fileStat.isFile()) {
    throw new WatchedSaveUnavailableError(watchedSavePath);
  }

  try {
    await readFile(watchedSavePath);
    return "present";
  } catch (error) {
    if (isMissingFileError(error)) {
      return "missing";
    }

    throw new WatchedSaveUnavailableError(watchedSavePath, { cause: error });
  }
}

async function readWatchedSaveStat(watchedSavePath: string) {
  try {
    return await stat(watchedSavePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw new WatchedSaveUnavailableError(watchedSavePath, { cause: error });
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
