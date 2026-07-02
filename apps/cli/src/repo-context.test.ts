import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  RepositoryContextError,
  resolveRepositoryContext,
} from "./repo-context.ts";

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-cli-context-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function createSaveHistoryRepositoryMarker(repoPath: string) {
  await mkdir(path.join(repoPath, ".silksong-git"), { recursive: true });
  await writeFile(path.join(repoPath, ".silksong-git/config.json"), "{}\n");
}

test("resolveRepositoryContext prefers an explicit repository path", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const explicitRepoPath = path.join(tempDirectory, "explicit-repo");
  const cwdRepoPath = path.join(tempDirectory, "cwd-repo");
  const cwd = path.join(cwdRepoPath, "nested");

  await createSaveHistoryRepositoryMarker(explicitRepoPath);
  await createSaveHistoryRepositoryMarker(cwdRepoPath);
  await mkdir(cwd, { recursive: true });

  assert.equal(
    await resolveRepositoryContext({
      explicitRepoPath,
      cwd,
    }),
    explicitRepoPath,
  );
});

test("resolveRepositoryContext walks upward to the nearest Save History Repository", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const outerRepoPath = path.join(tempDirectory, "outer-repo");
  const innerRepoPath = path.join(outerRepoPath, "child", "inner-repo");
  const cwd = path.join(innerRepoPath, "nested", "deeper");

  await createSaveHistoryRepositoryMarker(outerRepoPath);
  await createSaveHistoryRepositoryMarker(innerRepoPath);
  await mkdir(cwd, { recursive: true });

  assert.equal(await resolveRepositoryContext({ cwd }), innerRepoPath);
});

test("resolveRepositoryContext fails when no repository context exists", async (t) => {
  const tempDirectory = await createTempDirectory(t);

  await assert.rejects(
    async () => await resolveRepositoryContext({ cwd: tempDirectory }),
    RepositoryContextError,
  );
});
