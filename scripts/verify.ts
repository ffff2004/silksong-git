import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const VERIFY_ROOT = path.join(REPO_ROOT, ".cache", "verify");

const verifySteps = [
  { id: "lint", command: ["pnpm", "lint"] },
  { id: "test", command: ["pnpm", "test"] },
  { id: "build-web", command: ["pnpm", "build-web"] },
  { id: "build-desktop", command: ["pnpm", "build-desktop"] },
  { id: "verify-cli-pack", command: ["pnpm", "verify-cli-pack"] },
] as const;

type Reporter = "agent" | "human";
type RunStatus = "failed" | "interrupted" | "passed" | "running";
type StepStatus = "failed" | "interrupted" | "not-run" | "passed" | "running";

interface StepResult {
  readonly command: readonly string[];
  readonly exitCode?: number;
  readonly finishedAt?: string;
  readonly id: string;
  readonly logPath: string;
  readonly startedAt?: string;
  readonly status: StepStatus;
  readonly terminationSignal?: NodeJS.Signals;
}

interface RunResult {
  readonly currentStepId?: string;
  readonly exitCode?: number;
  readonly finishedAt?: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly status: RunStatus;
  readonly steps: readonly StepResult[];
  readonly terminationSignal?: NodeJS.Signals;
}

interface CompletedChild {
  readonly code: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
}

function getReporter(): Reporter {
  const reporterArgument = process.argv.find((argument) =>
    argument.startsWith("--reporter="),
  );
  const reporter = reporterArgument?.slice("--reporter=".length);

  if (reporter === "agent" || reporter === "human") {
    return reporter;
  }

  throw new Error("Expected --reporter=agent or --reporter=human.");
}

function getRunId() {
  const timestamp = getTimestamp();
  return `${timestamp.replaceAll(/\D/gv, "")}-${process.pid}`;
}

function getTimestamp() {
  const date = new Date();
  return date.toISOString();
}

async function writeJSON(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`);
  await rename(temporaryPath, filePath);
}

function formatCommand(command: readonly string[]) {
  return command.join(" ");
}

function formatRelativePath(filePath: string) {
  return path.relative(REPO_ROOT, filePath);
}

function printStepStart(
  reporter: Reporter,
  step: (typeof verifySteps)[number],
  index: number,
  logPath: string | undefined,
) {
  const command = formatCommand(step.command);

  if (reporter === "human") {
    console.log(`\n▶ step ${index + 1}/${verifySteps.length}: ${command}`);
    return;
  }

  if (logPath === undefined) {
    throw new Error("Agent verification steps must have a log path.");
  }

  console.log(`step ${index + 1}/${verifySteps.length}: ${step.id}`);
  console.log(`command: ${command}`);
  console.log("status: running");
  console.log(`log: ${formatRelativePath(logPath)}`);
}

function printStepCompleted(
  reporter: Reporter,
  step: (typeof verifySteps)[number],
) {
  if (reporter === "agent") {
    console.log(`status: passed (${step.id})`);
  }
}

function printStepFailed(
  reporter: Reporter,
  step: (typeof verifySteps)[number],
  completedChild: CompletedChild,
  logPath: string | undefined,
) {
  const exitDescription =
    completedChild.code === null
      ? `signal: ${completedChild.signal ?? "unknown"}`
      : `exit code: ${completedChild.code}`;

  console.error(`step failed: ${step.id}`);
  console.error(exitDescription);
  if (logPath !== undefined) {
    console.error(`log: ${formatRelativePath(logPath)}`);
  }

  if (reporter === "human" && completedChild.error !== undefined) {
    console.error(completedChild.error.message);
  }
}

async function runStep(
  command: readonly [string, ...string[]],
  logPath: string | undefined,
  reporter: Reporter,
  onChildStarted: (child: ChildProcessWithoutNullStreams) => void,
): Promise<CompletedChild> {
  const log = logPath === undefined ? undefined : createWriteStream(logPath);
  const [file, ...args] = command;
  const executable = process.platform === "win32" ? `${file}.cmd` : file;

  return await new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    onChildStarted(child);
    let childError: Error | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      log?.write(chunk);
      if (reporter === "human") {
        process.stdout.write(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      log?.write(chunk);
      if (reporter === "human") {
        process.stderr.write(chunk);
      }
    });
    child.on("error", (error: Error) => {
      childError = error;
      log?.write(`${error.message}\n`);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (log === undefined) {
        resolve({ code, error: childError, signal });
        return;
      }

      log.end(() => {
        resolve({ code, error: childError, signal });
      });
    });
  });
}

async function main() {
  const reporter = getReporter();
  const runId = getRunId();
  const runDirectory = path.join(VERIFY_ROOT, runId);
  const runPath = path.join(runDirectory, "run.json");
  const runStartedAt = getTimestamp();
  const persistsArtifacts = reporter === "agent";
  const results: StepResult[] = verifySteps.map((step, index) => ({
    command: step.command,
    id: step.id,
    logPath: `${String(index + 1).padStart(2, "0")}-${step.id}.log`,
    status: "not-run",
  }));

  if (persistsArtifacts) {
    await mkdir(runDirectory, { recursive: true });
  }

  async function save(
    runStatus: RunStatus,
    currentStepId?: string,
    exitCode?: number,
    terminationSignal?: NodeJS.Signals,
  ) {
    if (!persistsArtifacts) {
      return;
    }

    const finishedAt = runStatus === "running" ? undefined : getTimestamp();
    const run: RunResult = {
      ...(currentStepId !== undefined && { currentStepId }),
      ...(exitCode !== undefined && { exitCode }),
      ...(finishedAt !== undefined && { finishedAt }),
      ...(terminationSignal !== undefined && { terminationSignal }),
      runId,
      startedAt: runStartedAt,
      status: runStatus,
      steps: results,
    };

    await writeJSON(runPath, run);
    await writeJSON(path.join(VERIFY_ROOT, "latest.json"), {
      runPath: formatRelativePath(runPath),
      status: runStatus,
    });
  }

  await save("running");

  if (reporter === "agent") {
    console.log(`verify run: ${formatRelativePath(runDirectory)}`);
  }

  const interruption: {
    activeChild: ChildProcessWithoutNullStreams | undefined;
    signal: NodeJS.Signals | undefined;
  } = { activeChild: undefined, signal: undefined };
  const requestInterruption = (signal: NodeJS.Signals) => {
    interruption.signal = signal;
    interruption.activeChild?.kill(signal);
  };

  if (persistsArtifacts) {
    process.once("SIGINT", requestInterruption);
    process.once("SIGTERM", requestInterruption);
  }

  for (const [index, step] of verifySteps.entries()) {
    const previousResult = results[index];
    if (previousResult === undefined) {
      throw new Error(`Missing result for verification step ${step.id}.`);
    }

    const logPath = persistsArtifacts
      ? path.join(runDirectory, previousResult.logPath)
      : undefined;
    const stepStartedAt = getTimestamp();
    results[index] = {
      ...previousResult,
      startedAt: stepStartedAt,
      status: "running",
    };
    await save("running", step.id);
    printStepStart(reporter, step, index, logPath);

    const completedChild = await runStep(
      step.command,
      logPath,
      reporter,
      (child) => {
        interruption.activeChild = child;
        if (interruption.signal !== undefined) {
          child.kill(interruption.signal);
        }
      },
    );
    interruption.activeChild = undefined;
    const stepFinishedAt = getTimestamp();
    const terminationSignal = interruption.signal ?? completedChild.signal;
    const exitCode = completedChild.code;
    const passed =
      completedChild.code === 0 && completedChild.error === undefined;
    const interrupted = terminationSignal !== null;
    let stepStatus: StepStatus = passed ? "passed" : "failed";
    if (interrupted) {
      stepStatus = "interrupted";
    }

    results[index] = {
      ...results[index],
      ...(exitCode !== null && { exitCode }),
      finishedAt: stepFinishedAt,
      status: stepStatus,
      ...(terminationSignal !== null && { terminationSignal }),
    };

    if (!passed) {
      const runStatus: RunStatus = interrupted ? "interrupted" : "failed";
      await save(
        runStatus,
        step.id,
        exitCode ?? undefined,
        terminationSignal ?? undefined,
      );
      printStepFailed(reporter, step, completedChild, logPath);
      process.off("SIGINT", requestInterruption);
      process.off("SIGTERM", requestInterruption);

      if (terminationSignal !== null) {
        process.kill(process.pid, terminationSignal);
        return;
      }

      process.exitCode = exitCode ?? 1;
      return;
    }

    await save("running", step.id);
    printStepCompleted(reporter, step);
  }

  await save("passed", undefined, 0);

  if (interruption.signal !== undefined) {
    await save("interrupted", undefined, undefined, interruption.signal);
    process.off("SIGINT", requestInterruption);
    process.off("SIGTERM", requestInterruption);
    process.kill(process.pid, interruption.signal);
    return;
  }

  process.off("SIGINT", requestInterruption);
  process.off("SIGTERM", requestInterruption);
  if (reporter === "agent") {
    console.log("status: passed");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
