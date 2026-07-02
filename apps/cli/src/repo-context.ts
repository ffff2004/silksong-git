import { access } from "node:fs/promises";
import path from "node:path";

interface ResolveRepositoryContextInput {
  readonly explicitRepoPath?: string;
  readonly cwd?: string;
}

export async function resolveRepositoryContext(
  input: ResolveRepositoryContextInput = {},
): Promise<string> {
  if (input.explicitRepoPath !== undefined) {
    const repoPath = path.resolve(input.explicitRepoPath);
    await assertSaveHistoryRepository(repoPath);

    return repoPath;
  }

  const discoveredRepoPath = await findNearestSaveHistoryRepository(
    path.resolve(input.cwd ?? process.cwd()),
  );

  if (discoveredRepoPath === undefined) {
    throw new RepositoryContextError("error: repository path required");
  }

  return discoveredRepoPath;
}

export class RepositoryContextError extends Error {
  override name = "RepositoryContextError";
}

async function findNearestSaveHistoryRepository(
  startPath: string,
): Promise<string | undefined> {
  if (await isSaveHistoryRepository(startPath)) {
    return startPath;
  }

  const parentPath = path.dirname(startPath);
  if (parentPath === startPath) {
    return undefined;
  }

  return await findNearestSaveHistoryRepository(parentPath);
}

async function assertSaveHistoryRepository(repoPath: string) {
  if (!(await isSaveHistoryRepository(repoPath))) {
    throw new RepositoryContextError("error: invalid save history repository");
  }
}

async function isSaveHistoryRepository(repoPath: string): Promise<boolean> {
  try {
    await access(path.join(repoPath, ".silksong-git/config.json"));

    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
