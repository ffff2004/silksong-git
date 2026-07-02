import { execFile } from "node:child_process";

import { InvalidCommitRefError } from "./errors.ts";
import type { HistoryCommit } from "./types.ts";

class GitCommandError extends Error {
  readonly code: unknown;
  readonly stderr: string;

  constructor(
    message: string,
    options: { readonly code: unknown; readonly stderr: string } & ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitCommandError";
    this.code = options.code;
    this.stderr = options.stderr;
  }
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: createGitEnv(env) },
      (error, _stdout, stderr) => {
        if (error) {
          reject(toGitCommandError(error, stderr));
          return;
        }

        resolve();
      },
    );
  });
}

async function runGitOutput(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const output = await new Promise<{ stdout: string }>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, env: createGitEnv() },
      (error, stdout, stderr) => {
        if (error) {
          reject(toGitCommandError(error, stderr));
          return;
        }

        resolve({ stdout });
      },
    );
  });

  return output.stdout.trim();
}

export async function readObservationCommitRefs(
  repoPath: string,
): Promise<readonly string[]> {
  const head = await readCurrentHead(repoPath);

  if (head === undefined) {
    return [];
  }

  const output = await runGitOutput(repoPath, [
    "rev-list",
    "--reverse",
    "HEAD",
  ]);

  return output === "" ? [] : output.split("\n");
}

export async function readCurrentHead(
  repoPath: string,
): Promise<string | undefined> {
  try {
    return await runGitOutput(repoPath, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    if (error instanceof GitCommandError && isUnbornHeadError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function readHistoryCommit(
  repoPath: string,
  ref: string,
): Promise<HistoryCommit> {
  let fullRef: string;
  let shortRef: string;
  let committedAt: string;

  try {
    [fullRef, shortRef, committedAt] = await Promise.all([
      runGitOutput(repoPath, ["rev-parse", ref]),
      runGitOutput(repoPath, ["rev-parse", "--short", ref]),
      runGitOutput(repoPath, ["show", "-s", "--format=%cI", ref]),
    ]);
  } catch (error) {
    if (error instanceof GitCommandError && isInvalidGitRefError(error)) {
      throw new InvalidCommitRefError(ref, { cause: error });
    }

    throw error;
  }

  return {
    ref: fullRef,
    shortRef,
    committedAt,
  };
}

export async function readGitBlob(
  repoPath: string,
  commitRef: string,
  artifactPath: string,
): Promise<Buffer> {
  let output: { stdout: Buffer };

  try {
    output = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
      execFile(
        "git",
        ["show", `${commitRef}:${artifactPath}`],
        {
          encoding: "buffer",
          maxBuffer: 10 * 1024 * 1024,
          cwd: repoPath,
          env: createGitEnv(),
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(toGitCommandError(error, stderr.toString()));
            return;
          }

          resolve({ stdout });
        },
      );
    });
  } catch (error) {
    if (error instanceof GitCommandError && isInvalidGitRefError(error)) {
      throw new InvalidCommitRefError(commitRef, { cause: error });
    }

    throw error;
  }

  return output.stdout;
}

function createGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Keep Git diagnostics in English because error classification below still matches stderr text.
  // Prefer command shapes with stable exit-code semantics in the future, such as pre-validating
  // refs with rev-parse --verify --quiet.
  return {
    ...process.env,
    ...env,
    LANG: "C",
    LC_ALL: "C",
    LC_MESSAGES: "C",
    LANGUAGE: "C",
  };
}

function toGitCommandError(
  error: Error & { code?: unknown },
  stderr: string,
): GitCommandError {
  return new GitCommandError(error.message, {
    code: error.code,
    stderr,
    cause: error,
  });
}

function isUnbornHeadError(error: GitCommandError) {
  return (
    error.code === 128
    && (error.stderr.includes("Needed a single revision")
      || error.stderr.includes(
        "unknown revision or path not in the working tree",
      ))
  );
}

function isInvalidGitRefError(error: GitCommandError) {
  return (
    error.code === 128
    && (error.stderr.includes(
      "unknown revision or path not in the working tree",
    )
      || error.stderr.includes("bad revision")
      || error.stderr.includes("ambiguous argument")
      || error.stderr.includes("Needed a single revision"))
  );
}
