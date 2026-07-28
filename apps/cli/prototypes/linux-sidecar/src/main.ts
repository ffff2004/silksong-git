import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

import {
  initSaveHistory,
  observeSave,
  queryRawObservations,
  restoreEncodedSave,
} from "@silksong-git/history";

const PROTOCOL_VERSION = 1;
const bundledBinDirectory = requireAbsolutePath(
  process.env["SILKSONG_GIT_BUNDLED_BIN_DIR"],
  "SILKSONG_GIT_BUNDLED_BIN_DIR",
);

process.env["PATH"] = bundledBinDirectory;

interface CommandEnvelope {
  readonly version: number;
  readonly id: string;
  readonly command: "exercise" | "holdGit" | "reopen" | "shutdown";
  readonly workspacePath?: string;
  readonly fixturePath?: string;
  readonly repoPath?: string;
  readonly restorePath?: string;
  readonly activeDelayMs?: number;
}

const input = createInterface({
  input: process.stdin,
  terminal: false,
  crlfDelay: Infinity,
});
const activeOperations = new Set<Promise<void>>();
let acceptingCommands = true;
let shutdownPromise: Promise<void> | undefined;

emit({
  type: "ready",
  pid: process.pid,
  target: `${process.platform}-${process.arch}`,
  runtimeVersion: process.version,
});
log(`ready; bundled Git PATH=${bundledBinDirectory}`);

input.on("line", (line) => {
  void receiveLine(line);
});
input.on("close", () => {
  void requestShutdown("stdinClosed");
});
process.once("SIGINT", () => {
  void requestShutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void requestShutdown("SIGTERM");
});

async function receiveLine(line: string) {
  let command: CommandEnvelope;

  try {
    command = parseCommand(line);
  } catch (error) {
    emitError(undefined, error);
    return;
  }

  if (command.command === "shutdown") {
    await requestShutdown("command", command.id);
    return;
  }

  if (!acceptingCommands) {
    emitError(command.id, new Error("Sidecar is stopping"));
    return;
  }

  const operation = runCommand(command)
    .catch((error: unknown) => {
      emitError(command.id, error);
    })
    .finally(() => {
      activeOperations.delete(operation);
    });
  activeOperations.add(operation);
}

async function runCommand(command: CommandEnvelope) {
  emit({ type: "operationStarted", replyTo: command.id });
  const startedAt = performance.now();

  const result =
    command.command === "exercise"
      ? await exerciseHistory(command)
      : command.command === "holdGit"
        ? await holdBundledGit(command)
        : await reopenHistory(command);

  emit({
    type: "operationCompleted",
    replyTo: command.id,
    durationMs: roundMilliseconds(performance.now() - startedAt),
    result,
  });
}

async function holdBundledGit(command: CommandEnvelope) {
  const gitExecutablePath = path.join(bundledBinDirectory, "git");
  const git = spawn("git", ["hash-object", "--stdin"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  git.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    git.once("error", reject);
    git.once("spawn", () => {
      emit({
        type: "prototypeGitDescendant",
        replyTo: command.id,
        pid: git.pid,
        executablePath: gitExecutablePath,
      });
      resolve();
    });
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    git.once("error", reject);
    git.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(
      `Held bundled Git exited with ${
        exit.signal ?? `code ${String(exit.code)}`
      }: ${Buffer.concat(stderrChunks).toString("utf8")}`,
    );
  }
  return {
    gitPid: git.pid,
    gitExecutablePath,
  };
}

async function exerciseHistory(command: CommandEnvelope) {
  const workspacePath = requireAbsolutePath(command.workspacePath, "workspacePath");
  const fixturePath = requireAbsolutePath(command.fixturePath, "fixturePath");
  const repoPath = path.join(workspacePath, "history-repo");
  const watchedSavePath = path.join(workspacePath, "watched-save.dat");
  const fixtureBytes = await readFile(fixturePath);

  await mkdir(workspacePath, { recursive: true });
  await copyFile(fixturePath, watchedSavePath);
  const initialization = await measure(async () => {
    await initSaveHistory({ repoPath, watchedSavePath });
  });
  emit({
    type: "prototypePhase",
    replyTo: command.id,
    phase: "beforeObservation",
  });
  await delay(command.activeDelayMs ?? 0);
  const observation = await measure(
    async () =>
      await observeSave({
        repoPath,
        trigger: "manualCheckpoint",
      }),
  );

  if (observation.value.status !== "committed") {
    throw new Error(
      `Expected committed observation, got ${observation.value.status}`,
    );
  }

  const history = await measure(
    async () => await queryRawObservations({ repoPath }),
  );

  if (history.value.entries.length !== 1) {
    throw new Error(
      `Expected exactly one raw observation, got ${history.value.entries.length}`,
    );
  }

  return {
    repoPath,
    commitRef: observation.value.observation.commit.ref,
    encodedSha256: sha256Hex(fixtureBytes),
    rawObservationCount: history.value.entries.length,
    timingsMs: {
      initialization: initialization.durationMs,
      observation: observation.durationMs,
      query: history.durationMs,
    },
  };
}

async function reopenHistory(command: CommandEnvelope) {
  const repoPath = requireAbsolutePath(command.repoPath, "repoPath");
  const restorePath = requireAbsolutePath(command.restorePath, "restorePath");
  const history = await measure(
    async () => await queryRawObservations({ repoPath }),
  );
  const [entry] = history.value.entries;

  if (entry === undefined) {
    throw new Error("Expected an existing raw observation");
  }

  await rm(restorePath, { force: true });
  const restored = await measure(
    async () =>
      await restoreEncodedSave({
        repoPath,
        commitRef: entry.observation.commit.ref,
        target: { kind: "path", path: restorePath },
      }),
  );
  const restoredSha256 = sha256Hex(await readFile(restorePath));

  if (restoredSha256 !== entry.observation.encodedSha256) {
    throw new Error("Restored Encoded Save bytes do not match the observation");
  }

  return {
    commitRef: entry.observation.commit.ref,
    rawObservationCount: history.value.entries.length,
    restoredSha256,
    restoreResultSha256: restored.value.writtenSha256,
    timingsMs: {
      query: history.durationMs,
      restore: restored.durationMs,
    },
  };
}

async function requestShutdown(reason: string, replyTo?: string) {
  if (shutdownPromise !== undefined) {
    await shutdownPromise; return;
  }

  acceptingCommands = false;
  shutdownPromise = Promise.resolve().then(async () => {
      input.close();
      emit({
        type: "stopping",
        ...(replyTo !== undefined && { replyTo }),
        reason,
        activeOperationCount: activeOperations.size,
      });
      await Promise.allSettled(activeOperations);
      emit({
        type: "stopped",
        ...(replyTo !== undefined && { replyTo }),
      });
    });

  await shutdownPromise;
}

function parseCommand(line: string): CommandEnvelope {
  const value = JSON.parse(line) as Partial<CommandEnvelope>;

  if (value.version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${String(value.version)}`);
  }

  if (typeof value.id !== "string" || value.id === "") {
    throw new Error("Command id must be a non-empty string");
  }

  if (
    value.command !== "exercise"
    && value.command !== "holdGit"
    && value.command !== "reopen"
    && value.command !== "shutdown"
  ) {
    throw new Error(`Unknown command: ${String(value.command)}`);
  }

  if (
    value.activeDelayMs !== undefined
    && (!Number.isInteger(value.activeDelayMs)
      || value.activeDelayMs < 0
      || value.activeDelayMs > 10_000)
  ) {
    throw new Error("activeDelayMs must be an integer from 0 through 10000");
  }

  return value as CommandEnvelope;
}

function requireAbsolutePath(value: string | undefined, field: string): string {
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(`${field} must be an absolute path`);
  }

  return value;
}

function emit(message: Readonly<Record<string, unknown>>) {
  process.stdout.write(
    `${JSON.stringify({ version: PROTOCOL_VERSION, ...message })}\n`,
  );
}

function emitError(replyTo: string | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  log(message);
  emit({
    type: "error",
    ...(replyTo !== undefined && { replyTo }),
    code: "prototypeFailure",
    message,
  });
}

function log(message: string) {
  process.stderr.write(`[linux-sidecar-prototype] ${message}\n`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function delay(milliseconds: number) {
  return await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function measure<T>(
  operation: () => Promise<T>,
): Promise<{ readonly value: T; readonly durationMs: number }> {
  const startedAt = performance.now();
  const value = await operation();

  return {
    value,
    durationMs: roundMilliseconds(performance.now() - startedAt),
  };
}
