import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import { runPnpmExec } from "./pnpm-exec.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function execFileAsync(
  file: string,
  args: readonly string[],
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd: REPO_ROOT }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stderr, stdout });
        return;
      }

      const commandError: Error = Object.assign(error, { stderr, stdout });
      reject(commandError);
    });
  });
}

async function getGitCandidateFilePaths(): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);

  return stdout.split("\0").filter((filePath) => filePath !== "");
}

async function snapshotFileContents(
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, Buffer>> {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      const absoluteFilePath = path.resolve(REPO_ROOT, filePath);

      if (!(await isRegularFile(absoluteFilePath))) {
        return undefined;
      }

      return [filePath, await readFile(absoluteFilePath)] as const;
    }),
  );

  return new Map(entries.filter((entry) => entry !== undefined));
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile();
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code
  );
}

interface ChangedFile {
  readonly after: Buffer;
  readonly before: Buffer;
  readonly filePath: string;
}

function getChangedFiles(
  beforeContents: ReadonlyMap<string, Buffer>,
  afterContents: ReadonlyMap<string, Buffer>,
): readonly ChangedFile[] {
  return [...afterContents]
    .flatMap(([filePath, after]) => {
      const before = beforeContents.get(filePath);

      return before === undefined || before.equals(after)
        ? []
        : [{ after, before, filePath }];
    })
    .toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}

function printFormattedFiles(files: readonly ChangedFile[]) {
  if (files.length === 0) {
    console.log("No file changed by format.");
    return;
  }

  console.log("Formatted files:");
  for (const { filePath } of files) {
    console.log(`- ${filePath}`);
  }

  for (const { after, before, filePath } of files) {
    const normalizedFilePath = normalizeFilePath(filePath);
    console.log("");
    console.log(
      createTwoFilesPatch(
        `a/${normalizedFilePath}`,
        `b/${normalizedFilePath}`,
        before.toString(),
        after.toString(),
        "",
        "",
        { context: 3 },
      ).trimEnd(),
    );
  }
}

function normalizeFilePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.relative(REPO_ROOT, filePath)
    : filePath;
}

async function main() {
  const targets = process.argv.slice(2);
  const formatTargets = targets.length > 0 ? targets : ["."];
  const candidateFilePaths = await getGitCandidateFilePaths();

  // All execution paths use the same before/after comparison:
  // - success without changes reports that no files changed;
  // - success with changes prints the formatter-only diffs and exits successfully;
  // - failure without changes reports that no files changed, then exits unsuccessfully;
  // - failure after applying fixes prints those diffs, then exits unsuccessfully.
  const beforeContents = await snapshotFileContents(candidateFilePaths);
  let formatError: Error | undefined;

  // Keep all formatter failures in one cleanup-and-reporting boundary.
  // eslint-disable-next-line unicorn/try-complexity
  try {
    await runPnpmExec("eslint", ["--fix", ...formatTargets], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    await runPnpmExec(
      "prettier",
      ["--write", ...formatTargets, "--log-level", "warn"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );

    if (targets.length === 0) {
      await execFileAsync("pnpm", [
        "--filter",
        "@silksong-git/desktop",
        "format",
      ]);
    }
  } catch (error) {
    // ESLint or Prettier can modify files before returning a nonzero exit code. Defer the error so
    // the post-format snapshot and diff reporting still run for that partially successful work.
    formatError = error instanceof Error ? error : new Error(String(error));
  }

  const afterContents = await snapshotFileContents(candidateFilePaths);
  printFormattedFiles(getChangedFiles(beforeContents, afterContents));

  if (formatError !== undefined) {
    // Preserve the formatter's failure status only after reporting every change it made.
    throw formatError;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
