import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_ENTRY = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

await stat(TSX_ENTRY);

interface QualificationOptions {
  readonly expectedVersion: string | undefined;
  readonly gitBin: string;
}

interface CompletedProcess {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const options = parseOptions(process.argv.slice(2));
const testEnvironment = createTestEnvironment(options.gitBin);

const candidateVersion = await readCandidateVersion(testEnvironment);
if (
  options.expectedVersion !== undefined
  && candidateVersion !== options.expectedVersion
) {
  throw new Error(
    `Expected Git ${options.expectedVersion}, found Git ${candidateVersion}.`,
  );
}

for (const suite of ["packages/history/src", "packages/repo-session/src"]) {
  const testFiles = await getTestFiles(suite);
  const completed = await run(
    process.execPath,
    [TSX_ENTRY, "--test", ...testFiles],
    testEnvironment,
  );

  if (completed.code !== 0 || completed.signal !== null) {
    throw new Error(
      `${suite} qualification failed with ${describeCompletion(completed)}.`,
    );
  }
}

function parseOptions(args: readonly string[]): QualificationOptions {
  let gitBin: string | undefined;
  let expectedVersion: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--git-bin" || argument === "--expect-version") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }

      if (argument === "--git-bin") {
        gitBin = value;
      } else {
        expectedVersion = value;
      }
      index++;
      continue;
    }

    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (gitBin === undefined) {
    throw new Error("--git-bin is required.");
  }

  return {
    expectedVersion,
    gitBin: path.resolve(REPO_ROOT, gitBin),
  };
}

function createTestEnvironment(gitBin: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isGitEnvironmentKey(key) && value !== undefined) {
      environment[key] = value;
    }
  }

  environment["PATH"] = gitBin;
  return environment;
}

function isGitEnvironmentKey(key: string): boolean {
  return key.length >= 4 && key.slice(0, 4).toUpperCase() === "GIT_";
}

async function readCandidateVersion(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const output = await capture("git", ["--version"], environment);
  process.stdout.write(output);
  const match = /^git version (?<version>\d+\.\d+\.\d+)/v.exec(output.trim());
  const version = match?.groups?.["version"];
  if (version === undefined) {
    throw new Error(`Unexpected Git version output: ${output.trim()}`);
  }

  return version;
}

async function getTestFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(path.join(REPO_ROOT, directory), {
    withFileTypes: true,
  });
  const testFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => path.join(directory, entry.name))
    .toSorted();

  if (testFiles.length === 0) {
    throw new Error(`No test files found in ${directory}.`);
  }

  return testFiles;
}

async function run(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CompletedProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env: environment,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function capture(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: environment,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      reject(
        new Error(
          `Git --version failed with ${describeCompletion({ code, signal })}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}

function describeCompletion(completed: CompletedProcess): string {
  return completed.signal === null
    ? `exit code ${completed.code ?? "unknown"}`
    : `signal ${completed.signal}`;
}

function printUsage() {
  console.log(
    [
      "Usage: pnpm qualify-git --git-bin <directory> [--expect-version <version>]",
      "",
      "Runs Git --version, the complete History suite, and the complete Repo Session suite with PATH restricted to <directory> and ambient GIT_* variables removed.",
    ].join("\n"),
  );
}
