import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { initSaveHistory, observeSave, restoreEncodedSave } from "./index.ts";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "../../core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);

interface HistoryRepoFixture {
  readonly tempDirectory: string;
  readonly repoPath: string;
  readonly watchedSavePath: string;
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-history-git-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function createHistoryRepo(t: TestContext): Promise<HistoryRepoFixture> {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });

  return {
    tempDirectory,
    repoPath,
    watchedSavePath,
  };
}

async function runGitForTest(cwd: string, args: readonly string[]) {
  await new Promise<void>((resolve, reject) => {
    execFile("git", [...args], { cwd }, (error) => {
      if (error) {
        reject(toError(error));
        return;
      }

      resolve();
    });
  });
}

async function readGitBlobForTest(
  cwd: string,
  ref: string,
  artifactPath: string,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["show", `${ref}:${artifactPath}`],
      {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
        cwd,
      },
      (error, stdout) => {
        if (error) {
          reject(toError(error));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

test("observeSave commits with managed identity when Git identity config is unusable", async (t) => {
  const repo = await createHistoryRepo(t);

  await runGitForTest(repo.repoPath, ["config", "user.name", ""]);
  await runGitForTest(repo.repoPath, ["config", "user.email", ""]);
  await runGitForTest(repo.repoPath, ["config", "user.useConfigOnly", "true"]);

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
});

test("observeSave commits when Git commit signing is configured but unavailable", async (t) => {
  const repo = await createHistoryRepo(t);

  await runGitForTest(repo.repoPath, ["config", "commit.gpgSign", "true"]);
  await runGitForTest(repo.repoPath, [
    "config",
    "gpg.program",
    path.join(repo.tempDirectory, "missing-gpg"),
  ]);

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
});

test("observeSave commits when Git hooks are configured to fail", async (t) => {
  const repo = await createHistoryRepo(t);
  const hooksPath = path.join(repo.tempDirectory, "bad-hooks");
  const prepareCommitMessageHook = path.join(hooksPath, "prepare-commit-msg");

  await mkdir(hooksPath);
  await writeFile(prepareCommitMessageHook, "#!/bin/sh\nexit 1\n");
  await chmod(prepareCommitMessageHook, 0o755);
  await runGitForTest(repo.repoPath, ["config", "core.hooksPath", hooksPath]);

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
});

test("observeSave preserves Encoded Save bytes despite Git attributes filters", async (t) => {
  const repo = await createHistoryRepo(t);

  await writeFile(
    path.join(repo.repoPath, ".gitattributes"),
    ["save.dat filter=corrupt-save", ""].join("\n"),
  );
  await runGitForTest(repo.repoPath, [
    "config",
    "filter.corrupt-save.clean",
    "sh -c 'printf corrupted'",
  ]);
  await runGitForTest(repo.repoPath, [
    "config",
    "filter.corrupt-save.smudge",
    "cat",
  ]);

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");

  const originalSave = await readFile(minimalEncodedSavePath);
  assert.deepEqual(
    await readGitBlobForTest(repo.repoPath, "HEAD", "save.dat"),
    originalSave,
  );

  const restorePath = path.join(repo.tempDirectory, "restored-save.dat");
  await restoreEncodedSave({
    repoPath: repo.repoPath,
    commitRef: result.observation.commit.ref,
    target: {
      kind: "path",
      path: restorePath,
    },
  });
  assert.deepEqual(await readFile(restorePath), originalSave);
});

test("observeSave keeps committed JSON artifacts LF-normalized under CRLF config", async (t) => {
  const repo = await createHistoryRepo(t);

  await runGitForTest(repo.repoPath, ["config", "core.autocrlf", "true"]);
  await runGitForTest(repo.repoPath, ["config", "core.eol", "crlf"]);
  await writeFile(
    path.join(repo.repoPath, ".gitattributes"),
    ["* text=auto", "*.json text eol=crlf", ""].join("\n"),
  );

  const result = await observeSave({
    repoPath: repo.repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");

  const decodedSaveJson = await readGitBlobForTest(
    repo.repoPath,
    "HEAD",
    "decoded-save.json",
  );
  const observationJson = await readGitBlobForTest(
    repo.repoPath,
    "HEAD",
    "observation.json",
  );

  assert.equal(decodedSaveJson.includes("\r\n"), false);
  assert.equal(observationJson.includes("\r\n"), false);
});
