import { isArray } from "complete-common";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

interface EslintResult {
  readonly filePath?: unknown;
  readonly messages?: unknown;
  readonly output?: unknown;
}

interface EslintMessage {
  readonly column?: unknown;
  readonly line?: unknown;
  readonly message?: unknown;
  readonly ruleId?: unknown;
}

type CommandOutputError = Error & {
  readonly code?: unknown;
  readonly stderr?: unknown;
  readonly stdout?: unknown;
};

async function getEslintFixableFilePaths(): Promise<readonly string[]> {
  const results = await runEslintDryRun();

  return results
    .filter(
      (result): result is EslintResult & { readonly filePath: string } =>
        typeof result.filePath === "string"
        && typeof result.output === "string",
    )
    .map((result) => result.filePath);
}

async function runEslintDryRun(): Promise<readonly EslintResult[]> {
  try {
    const { stdout } = await execFileAsync("eslint", [
      "--fix-dry-run",
      "--format",
      "json",
      ".",
    ]);
    return parseEslintResults(stdout);
  } catch (error) {
    const { stdout } = error as CommandOutputError;

    if (typeof stdout === "string" && stdout.trim() !== "") {
      const results = parseEslintResults(stdout);
      const details = formatEslintMessages(results);

      if (details !== "") {
        throw new Error(`ESLint failed during format dry run:\n${details}`, {
          cause: error,
        });
      }
    }

    throw error;
  }
}

function parseEslintResults(stdout: string): readonly EslintResult[] {
  return JSON.parse(stdout) as readonly EslintResult[];
}

function formatEslintMessages(results: readonly EslintResult[]): string {
  return results
    .flatMap((result) => {
      if (typeof result.filePath !== "string" || !isArray(result.messages)) {
        return [];
      }

      const filePath = normalizeFilePath(result.filePath);
      return result.messages
        .filter(isEslintMessage)
        .map((message) => formatEslintMessage(filePath, message));
    })
    .join("\n");
}

function isEslintMessage(value: unknown): value is EslintMessage {
  return typeof value === "object" && value !== null;
}

function formatEslintMessage(filePath: string, message: EslintMessage): string {
  const line =
    typeof message.line === "number" && typeof message.column === "number"
      ? `${message.line}:${message.column}`
      : "unknown";
  const ruleId = typeof message.ruleId === "string" ? ` ${message.ruleId}` : "";
  const messageText =
    typeof message.message === "string"
      ? message.message
      : "Unknown ESLint error";

  return `- ${filePath}:${line}${ruleId} ${messageText}`;
}

async function getPrettierDifferentFilePaths(): Promise<readonly string[]> {
  try {
    const { stdout } = await execFileAsync("prettier", [
      "--list-different",
      ".",
    ]);
    return parseFileList(stdout);
  } catch (error) {
    const { code, stdout } = error as CommandOutputError;

    if (code === 1 && typeof stdout === "string") {
      return parseFileList(stdout);
    }

    throw error;
  }
}

function parseFileList(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
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
  const eslintFixableFilePaths = await getEslintFixableFilePaths();
  await runCommand("eslint", ["--fix", "."]);

  const prettierDifferentFilePaths = await getPrettierDifferentFilePaths();
  await runCommand("prettier", ["--write", ".", "--log-level", "warn"]);

  printFormattedFiles([
    ...eslintFixableFilePaths,
    ...prettierDifferentFilePaths,
  ]);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
