import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TSX_ENTRY = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const GIT_VERSION_OUTPUT_LIMIT_BYTES = 64 * 1024;

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
    if (!isRestrictedEnvironmentKey(key) && value !== undefined) {
      environment[key] = value;
    }
  }

  environment["PATH"] = gitBin;
  environment["GIT_ATTR_NOSYSTEM"] = "1";
  environment["GIT_CONFIG_GLOBAL"] = devNull;
  environment["GIT_CONFIG_NOSYSTEM"] = "1";
  environment["GIT_TERMINAL_PROMPT"] = "0";
  environment["LANG"] = "C";
  environment["LC_ALL"] = "C";
  environment["LC_MESSAGES"] = "C";
  environment["LANGUAGE"] = "C";
  return environment;
}

function isRestrictedEnvironmentKey(key: string): boolean {
  return (
    hasAsciiCaseInsensitivePrefix(key, "GIT_")
    || hasAsciiCaseInsensitivePrefix(key, "NODE_")
  );
}

function hasAsciiCaseInsensitivePrefix(value: string, prefix: string): boolean {
  if (value.length < prefix.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index++) {
    const valueCode = value.codePointAt(index);
    const prefixCode = prefix.codePointAt(index);

    if (
      valueCode === undefined
      || prefixCode === undefined
      || toAsciiUpperCode(valueCode) !== toAsciiUpperCode(prefixCode)
    ) {
      return false;
    }
  }

  return true;
}

function toAsciiUpperCode(code: number): number {
  return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
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
  const collectedTestFiles = await collectTestFiles(
    path.join(REPO_ROOT, directory),
    directory,
  );
  const testFiles = collectedTestFiles.toSorted();

  if (testFiles.length === 0) {
    throw new Error(`No test files found in ${directory}.`);
  }

  return testFiles;
}

async function collectTestFiles(
  absoluteDirectory: string,
  relativeDirectory: string,
): Promise<readonly string[]> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);

      if (entry.isDirectory()) {
        return await collectTestFiles(
          path.join(absoluteDirectory, entry.name),
          relativePath,
        );
      }

      return entry.isFile() && entry.name.endsWith(".test.ts")
        ? [relativePath]
        : [];
    }),
  );

  return nestedFiles.flat();
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
    const outputLengths = { stderr: 0, stdout: 0 };
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      reject(error);
    };

    const collect = (
      stream: "stderr" | "stdout",
      chunk: Readonly<Buffer>,
    ): Buffer | undefined => {
      const nextLength = outputLengths[stream] + chunk.length;
      if (nextLength > GIT_VERSION_OUTPUT_LIMIT_BYTES) {
        fail(
          new Error(
            `Git --version ${stream} exceeded the ${GIT_VERSION_OUTPUT_LIMIT_BYTES}-byte capture limit.`,
          ),
        );
        return undefined;
      }

      outputLengths[stream] = nextLength;
      return Buffer.from(chunk);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const collected = collect("stdout", chunk);
      if (collected !== undefined) {
        stdout.push(collected);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const collected = collect("stderr", chunk);
      if (collected !== undefined) {
        stderr.push(collected);
      }
    });
    child.once("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }

      if (code === 0 && signal === null) {
        settled = true;
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      fail(
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
      "Runs Git --version, the complete History suite, and the complete Repo Session suite with PATH restricted to <directory> and ambient GIT_*/NODE_* variables removed.",
    ].join("\n"),
  );
}
