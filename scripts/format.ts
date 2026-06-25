import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function execFileAsync(
  file: string,
  args: readonly string[],
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  return await new Promise((resolve, reject) => {
    execFile(file, [...args], (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stderr, stdout });
        return;
      }

      const commandError: Error = Object.assign(error, { stderr, stdout });
      reject(commandError);
    });
  });
}

async function runCommand(command: string, args: readonly string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
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

async function snapshotFileHashes(
  filePaths: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    filePaths.map(async (filePath) => {
      const absoluteFilePath = path.resolve(REPO_ROOT, filePath);

      if (!(await isRegularFile(absoluteFilePath))) {
        return undefined;
      }

      const content = await readFile(absoluteFilePath);
      return [filePath, hashContent(content)] as const;
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

function hashContent(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function getChangedFilePaths(
  beforeHashes: ReadonlyMap<string, string>,
  afterHashes: ReadonlyMap<string, string>,
): readonly string[] {
  return [...afterHashes]
    .filter(([filePath, afterHash]) => beforeHashes.get(filePath) !== afterHash)
    .map(([filePath]) => filePath);
}

function printFormattedFiles(filePaths: readonly string[]) {
  const uniqueFilePaths = [
    ...new Set(filePaths.map((filePath) => normalizeFilePath(filePath))),
  ].toSorted();

  if (uniqueFilePaths.length === 0) {
    console.log("No files changed by format.");
    return;
  }

  console.log("Formatted files:");
  for (const filePath of uniqueFilePaths) {
    console.log(`- ${filePath}`);
  }
}

function normalizeFilePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.relative(REPO_ROOT, filePath)
    : filePath;
}

async function main() {
  const candidateFilePaths = await getGitCandidateFilePaths();
  const beforeHashes = await snapshotFileHashes(candidateFilePaths);

  await runCommand("eslint", ["--fix", "."]);
  await runCommand("prettier", ["--write", ".", "--log-level", "warn"]);

  const afterHashes = await snapshotFileHashes(candidateFilePaths);
  printFormattedFiles(getChangedFilePaths(beforeHashes, afterHashes));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
