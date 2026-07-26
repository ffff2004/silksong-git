import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { BuiltSidecar } from "./build.ts";

const CLEAN_IMAGE =
  "docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e";
const PROTOTYPE_DIRECTORY = import.meta.dirname;
const REPOSITORY_ROOT = path.resolve(PROTOTYPE_DIRECTORY, "../../../..");
const FIXTURE_PATH = path.join(
  REPOSITORY_ROOT,
  "packages/core/src/decode/fixtures/minimal-valid-save.dat",
);

interface ProtocolMessage {
  readonly version: number;
  readonly type: string;
  readonly replyTo?: string;
  readonly [key: string]: unknown;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export async function verifyLinuxSidecar(
  built: BuiltSidecar,
): Promise<Record<string, unknown>> {
  await assertCleanImageHasNoNodeOrGit();
  const scratchDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-sidecar-prototype-"),
  );

  try {
    const first = startSidecar({
      built,
      scratchDirectory,
      name: `silksong-sidecar-exercise-${process.pid}`,
    });
    const firstReady = await first.waitFor(
      (message) => message.type === "ready",
    );
    const firstStartupMs = first.elapsedMilliseconds();

    assertEqual(firstReady["runtimeVersion"], "v24.18.0", "runtime version");
    first.send({
      version: 1,
      id: "exercise-1",
      command: "exercise",
      workspacePath: "/work/session",
      fixturePath: "/fixture/minimal-valid-save.dat",
      activeDelayMs: 500,
    });
    await first.waitFor(
      (message) =>
        message.type === "prototypePhase"
        && message.replyTo === "exercise-1"
        && message["phase"] === "beforeObservation",
    );
    first.send({ version: 1, id: "shutdown-1", command: "shutdown" });
    const stopping = await first.waitFor(
      (message) =>
        message.type === "stopping" && message.replyTo === "shutdown-1",
    );
    assertEqual(
      stopping["activeOperationCount"],
      1,
      "active operation count during shutdown",
    );
    const exercised = await first.waitFor(
      (message) =>
        message.type === "operationCompleted"
        && message.replyTo === "exercise-1",
    );
    await first.waitFor(
      (message) =>
        message.type === "stopped" && message.replyTo === "shutdown-1",
    );
    assertMessageOrder(first.messages, "operationCompleted", "stopped");
    assertSuccessfulExit(await first.exit);
    first.assertSeparatedOutput();

    const exerciseResult = requireRecord(exercised["result"], "exercise result");
    const expectedSha256 = requireString(
      exerciseResult["encodedSha256"],
      "encodedSha256",
    );
    assertEqual(
      exerciseResult["rawObservationCount"],
      1,
      "raw observation count",
    );

    const second = startSidecar({
      built,
      scratchDirectory,
      name: `silksong-sidecar-reopen-${process.pid}`,
    });
    await second.waitFor((message) => message.type === "ready");
    const secondStartupMs = second.elapsedMilliseconds();
    second.send({
      version: 1,
      id: "reopen-1",
      command: "reopen",
      repoPath: "/work/session/history-repo",
      restorePath: "/work/restored.dat",
    });
    const reopened = await second.waitFor(
      (message) =>
        message.type === "operationCompleted"
        && message.replyTo === "reopen-1",
    );
    second.send({ version: 1, id: "shutdown-2", command: "shutdown" });
    await second.waitFor(
      (message) =>
        message.type === "stopped" && message.replyTo === "shutdown-2",
    );
    assertSuccessfulExit(await second.exit);
    second.assertSeparatedOutput();

    const reopenResult = requireRecord(reopened["result"], "reopen result");
    assertEqual(
      reopenResult["restoredSha256"],
      expectedSha256,
      "restored SHA-256",
    );
    assertEqual(
      reopenResult["restoreResultSha256"],
      expectedSha256,
      "History restore result SHA-256",
    );
    const fixtureBytes = await readFile(FIXTURE_PATH);
    const restoredBytes = await readFile(
      path.join(scratchDirectory, "restored.dat"),
    );

    if (!fixtureBytes.equals(restoredBytes)) {
      throw new Error("Restored Encoded Save is not byte-for-byte exact");
    }

    const crashed = startSidecar({
      built,
      scratchDirectory,
      name: `silksong-sidecar-crash-${process.pid}`,
    });
    await crashed.waitFor((message) => message.type === "ready");
    await run("podman", [
      "kill",
      "--signal",
      "KILL",
      crashed.containerName,
    ]);
    const crashExit = await crashed.exit;

    if (crashExit.code === 0) {
      throw new Error("Supervisor failed to detect unexpected sidecar exit");
    }

    if (crashed.messages.some((message) => message.type === "stopped")) {
      throw new Error("Killed sidecar incorrectly emitted a stopped event");
    }

    const inventory = await inspectArtifact(built);
    const evidence = {
      verifiedAt: new Date().toISOString(),
      targetTriple: built.targetTriple,
      cleanImage: CLEAN_IMAGE,
      cleanEnvironment: {
        systemNodePresent: false,
        systemGitPresent: false,
        network: "disabled",
      },
      runtimeVersion: firstReady["runtimeVersion"],
      protocol: {
        version: firstReady.version,
        stdoutJsonlOnly: true,
        stderrLogObserved: true,
        gracefulShutdownWaitedForActiveOperation: true,
        unexpectedExitDetected: true,
        unexpectedExit: crashExit,
      },
      timingsMs: {
        firstStartup: roundMilliseconds(firstStartupMs),
        secondStartup: roundMilliseconds(secondStartupMs),
        exerciseTotal: exercised["durationMs"],
        reopenTotal: reopened["durationMs"],
        exercise: exerciseResult["timingsMs"],
        reopen: reopenResult["timingsMs"],
      },
      history: {
        rawObservationCount: exerciseResult["rawObservationCount"],
        commitRef: exerciseResult["commitRef"],
        encodedSha256: expectedSha256,
        restoredSha256: reopenResult["restoredSha256"],
        byteExactRestore: true,
      },
      artifact: inventory,
    };

    await writeFile(
      path.join(PROTOTYPE_DIRECTORY, "dist/evidence.json"),
      `${JSON.stringify(evidence, undefined, 2)}\n`,
    );

    return evidence;
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

async function assertCleanImageHasNoNodeOrGit() {
  await run("podman", [
    "run",
    "--rm",
    "--network=none",
    CLEAN_IMAGE,
    "sh",
    "-c",
    [
      "if command -v node >/dev/null 2>&1; then exit 11; fi",
      "if command -v git >/dev/null 2>&1; then exit 12; fi",
    ].join("\n"),
  ]);
}

function startSidecar(input: {
  readonly built: BuiltSidecar;
  readonly scratchDirectory: string;
  readonly name: string;
}) {
  const startedAt = performance.now();
  const child = spawn(
    "podman",
    [
      "run",
      "--rm",
      "--interactive",
      "--name",
      input.name,
      "--network=none",
      "--volume",
      `${input.built.artifactDirectory}:/artifact:ro`,
      "--volume",
      `${FIXTURE_PATH}:/fixture/minimal-valid-save.dat:ro`,
      "--volume",
      `${input.scratchDirectory}:/work`,
      "--env",
      "HOME=/work/home",
      "--env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "--env",
      "SILKSONG_GIT_BUNDLED_BIN_DIR=/artifact/resources/bin",
      CLEAN_IMAGE,
      `/artifact/bin/${path.basename(input.built.binaryPath)}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: ProtocolMessage[] = [];
  const stderrChunks: Buffer[] = [];
  const listeners = new Set<() => void>();
  let stdoutBuffer = "";
  let parseError: Error | undefined;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");

    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);

      try {
        const message = JSON.parse(line) as ProtocolMessage;

        if (message.version !== 1 || typeof message.type !== "string") {
          throw new Error(`Invalid protocol message: ${line}`);
        }

        messages.push(message);
      } catch (error) {
        parseError =
          error instanceof Error ? error : new Error(String(error));
      }

      for (const listener of listeners) {
        listener();
      }

      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  const exit = waitForExit(child).finally(() => {
    for (const listener of listeners) {
      listener();
    }
  });

  return {
    containerName: input.name,
    messages,
    exit,
    elapsedMilliseconds: () => performance.now() - startedAt,
    send(message: Readonly<Record<string, unknown>>) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async waitFor(
      predicate: (message: ProtocolMessage) => boolean,
      timeoutMs = 10_000,
    ): Promise<ProtocolMessage> {
      const deadline = performance.now() + timeoutMs;

      while (true) {
        if (parseError !== undefined) {
          throw parseError;
        }

        const match = messages.find(predicate);

        if (match !== undefined) {
          return match;
        }

        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("Sidecar exited before the expected protocol message");
        }

        const remaining = deadline - performance.now();

        if (remaining <= 0) {
          throw new Error("Timed out waiting for sidecar protocol message");
        }

        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            listeners.delete(onMessage);
            resolve();
          }, remaining);
          const onMessage = () => {
            clearTimeout(timer);
            listeners.delete(onMessage);
            resolve();
          };
          listeners.add(onMessage);
        });
      }
    },
    assertSeparatedOutput() {
      if (stdoutBuffer !== "") {
        throw new Error("Sidecar stdout ended with a non-JSONL fragment");
      }

      const stderr = Buffer.concat(stderrChunks).toString("utf8");

      if (!stderr.includes("[linux-sidecar-prototype]")) {
        throw new Error("Expected sidecar log output on stderr");
      }
    },
  };
}

async function inspectArtifact(built: BuiltSidecar) {
  const noticeDirectory = path.join(built.artifactDirectory, "notices");
  const noticeFiles = (await readdir(noticeDirectory)).toSorted();
  const expectedNoticeFiles = [
    "GIT-COPYING",
    "NODE-LICENSE",
    "PROTOTYPE-NOTICES.md",
  ];

  assertEqual(
    JSON.stringify(noticeFiles),
    JSON.stringify(expectedNoticeFiles),
    "artifact notice files",
  );
  const [sidecarStat, gitStat, totalBytes, sidecarFile, gitFile, gitDynamic] =
    await Promise.all([
      stat(built.binaryPath),
      stat(built.gitPath),
      directorySize(built.artifactDirectory),
      capture("file", [built.binaryPath]),
      capture("file", [built.gitPath]),
      capture("readelf", ["-d", built.gitPath]),
    ]);

  return {
    totalBytes,
    sidecarBytes: sidecarStat.size,
    gitBytes: gitStat.size,
    noticesAndOtherBytes: totalBytes - sidecarStat.size - gitStat.size,
    sidecarSha256: await sha256File(built.binaryPath),
    gitSha256: await sha256File(built.gitPath),
    sidecarFile: sidecarFile.trim(),
    gitFile: gitFile.trim(),
    gitHasDynamicDependency: gitDynamic.includes("(NEEDED)"),
    noticeFiles,
  };
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    total += entry.isDirectory()
      ? await directorySize(entryPath)
      : (await stat(entryPath)).size;
  }

  return total;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

async function capture(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  assertSuccessfulExit(await waitForExit(child));

  return Buffer.concat(chunks).toString("utf8");
}

async function run(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], { stdio: "inherit" });
  assertSuccessfulExit(await waitForExit(child));
}

async function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function assertSuccessfulExit(exit: ProcessExit) {
  if (exit.code !== 0) {
    throw new Error(
      `Process failed with ${exit.signal ?? `exit code ${String(exit.code)}`}`,
    );
  }
}

function assertMessageOrder(
  messages: readonly ProtocolMessage[],
  firstType: string,
  secondType: string,
) {
  const first = messages.findIndex((message) => message.type === firstType);
  const second = messages.findIndex((message) => message.type === secondType);

  if (first === -1 || second === -1 || first >= second) {
    throw new Error(
      `Expected ${firstType} before ${secondType} in protocol output`,
    );
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${label} to be a string`);
  }

  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(
      `Unexpected ${label}: expected ${String(expected)}, got ${String(actual)}`,
    );
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
