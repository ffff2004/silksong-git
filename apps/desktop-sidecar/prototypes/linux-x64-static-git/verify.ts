import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
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

import type {
  DesktopSidecarProducedMessage,
  DesktopSidecarResponse,
} from "../../src/protocol.ts";
import {
  desktopSidecarOutputEnvelopeSchema,
  desktopSidecarProtocolVersion,
} from "../../src/protocol.ts";

import type { BuiltSidecar } from "./build.ts";

const cleanImage =
  "docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e";
const targetTriple = "x86_64-unknown-linux-gnu";
const prototypeDirectory = import.meta.dirname;
const repositoryRoot = path.resolve(prototypeDirectory, "../../../..");
const fixturePath = path.join(
  repositoryRoot,
  "packages/core/src/decode/fixtures/minimal-valid-save.dat",
);

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface CapturedProcess extends ProcessExit {
  readonly stderr: Buffer;
  readonly stdout: Buffer;
}

interface SidecarProcess {
  readonly containerName: string;
  readonly messages: DesktopSidecarProducedMessage[];
  readonly stderr: () => string;
  readonly exit: Promise<ProcessExit>;
  send: (message: Readonly<Record<string, unknown>>) => void;
  readMessage: () => Promise<DesktopSidecarProducedMessage>;
  readResponse: (requestId: string) => Promise<DesktopSidecarResponse>;
  terminate: () => Promise<void>;
}

export async function verifyLinuxSidecar(
  built: BuiltSidecar,
): Promise<Record<string, unknown>> {
  await ensureCleanImage();
  const staticCurlPath = await prepareStaticCurl();
  const scratchDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-static-git-sidecar-"),
  );
  const sidecars: SidecarProcess[] = [];
  const watchedSavePath = path.join(scratchDirectory, "watched-save.dat");

  try {
    await copyFixtureTo(watchedSavePath);
    const first = startSidecar({
      built,
      curlPath: staticCurlPath,
      name: `silksong-static-git-${process.pid}-first`,
      scratchDirectory,
    });
    sidecars.push(first);
    await assertReady(first);
    const firstStartupMs = first.startedAtMs();

    first.send(
      command("initialize", {
        type: "repository.initialize",
        repoPath: "/work/history-repo",
        watchedSavePath: "/work/watched-save.dat",
      }),
    );
    const initialization = await first.readResponse("initialize");
    assertResponseResultType(initialization, "repository.initializationResult");
    assertEqual(
      record(initialization.result)["initialization"],
      { status: "initialized" },
      "initialization result",
    );

    first.send(
      command("open", {
        type: "session.open",
        repoPath: "/work/history-repo",
      }),
    );
    const opened = await first.readResponse("open");
    assertResponseResultType(opened, "session.opened");
    const connection = readConnection(opened);

    const observations = await requestJson(
      first,
      connection,
      "/api/v1/observations",
    );
    const entries = array(
      record(observations)["entries"],
      "observation entries",
    );
    assertEqual(entries.length, 1, "initial raw observation count");
    const firstEntry = record(entries[0]);
    const observation = record(firstEntry["observation"]);
    const commit = record(observation["commit"]);
    const commitRef = string(commit["ref"], "observation commit ref");
    const encodedSha256 = string(
      observation["encodedSha256"],
      "observation encoded SHA-256",
    );

    const history = await requestJson(first, connection, "/api/v1/history");
    assertEqual(
      Array.isArray(record(history)["events"]),
      true,
      "history response events",
    );
    const exported = await requestBytes(
      first,
      connection,
      `/api/v1/export?commit=${encodeURIComponent(commitRef)}`,
    );
    const fixture = await readFile(fixturePath);
    assertBufferEqual(exported, fixture, "exported Encoded Save");

    const mutated = Buffer.from(fixture);
    mutated[0] = (mutated[0] ?? 0) ^ 0xff;
    await writeFile(watchedSavePath, mutated);
    const mutatedSha256 = sha256(mutated);
    const restored = await requestJson(
      first,
      connection,
      "/api/v1/restores/in-place",
      {
        method: "POST",
        body: JSON.stringify({
          commitRef,
          confirmation: "restore-watched-save",
          expectedCurrent: {
            status: "present",
            encodedSha256: mutatedSha256,
          },
        }),
      },
    );
    assertEqual(
      string(record(restored)["writtenSha256"], "restore SHA-256"),
      encodedSha256,
      "restore SHA-256",
    );
    assertBufferEqual(
      await readFile(watchedSavePath),
      fixture,
      "restored Watched Save",
    );

    first.send(command("shutdown", { type: "process.shutdown" }));
    const shutdown = await first.readResponse("shutdown");
    assertResponseResultType(shutdown, "process.shutdownComplete");
    const firstExit = await first.exit;
    assertSuccessfulExit(firstExit, "first sidecar");
    assertProtocolMessages(first.messages);

    const second = startSidecar({
      built,
      curlPath: staticCurlPath,
      name: `silksong-static-git-${process.pid}-second`,
      scratchDirectory,
    });
    sidecars.push(second);
    await assertReady(second);
    const secondStartupMs = second.startedAtMs();
    second.send(
      command("reopen", {
        type: "session.open",
        repoPath: "/work/history-repo",
      }),
    );
    const reopened = await second.readResponse("reopen");
    assertResponseResultType(reopened, "session.opened");
    const reopenedConnection = readConnection(reopened);
    const reopenedObservations = await requestJson(
      second,
      reopenedConnection,
      "/api/v1/observations",
    );
    assertEqual(
      array(
        record(reopenedObservations)["entries"],
        "reopened observation entries",
      ).length,
      1,
      "reopened raw observation count",
    );
    second.send(command("shutdown-2", { type: "process.shutdown" }));
    const shutdownSecond = await second.readResponse("shutdown-2");
    assertResponseResultType(shutdownSecond, "process.shutdownComplete");
    const secondExit = await second.exit;
    assertSuccessfulExit(secondExit, "reopened sidecar");
    assertProtocolMessages(second.messages);

    const crashed = startSidecar({
      built,
      curlPath: staticCurlPath,
      name: `silksong-static-git-${process.pid}-crashed`,
      scratchDirectory,
    });
    sidecars.push(crashed);
    await assertReady(crashed);
    await runChecked("podman", [
      "kill",
      "--signal",
      "KILL",
      crashed.containerName,
    ]);
    const crashExit = await crashed.exit;
    if (crashExit.code === 0 || crashExit.signal !== null) {
      throw new Error(
        `Expected unexpected sidecar exit, got ${describeExit(crashExit)}.`,
      );
    }
    if (
      crashed.messages.some(
        (message) =>
          message.kind === "response"
          && message.ok
          && message.result.type === "process.shutdownComplete",
      )
    ) {
      throw new Error(
        "Killed sidecar emitted a false graceful-shutdown result.",
      );
    }
    assertProtocolMessages(crashed.messages);

    const artifact = await inspectArtifact(built);
    const evidence = {
      verifiedAt: new Date().toISOString(),
      targetTriple,
      cleanImage,
      cleanEnvironment: {
        systemNodePresent: false,
        systemGitPresent: false,
        runtimeNetwork: "disabled",
        httpClient: "test-only static curl",
      },
      sidecarProtocolVersion: desktopSidecarProtocolVersion,
      protocol: {
        stdoutJsonlOnly: true,
        stderrSeparated: first.stderr().length === 0,
        gracefulShutdownExit: firstExit,
        unexpectedExitDetected: true,
        unexpectedExit: crashExit,
      },
      timingsMs: {
        firstStartup: roundMilliseconds(firstStartupMs),
        secondStartup: roundMilliseconds(secondStartupMs),
      },
      history: {
        rawObservationCount: entries.length,
        commitRef,
        encodedSha256,
        exportedByteExact: true,
        restoredByteExact: true,
      },
      artifact,
    };
    await writeFile(
      path.join(prototypeDirectory, "dist/evidence.json"),
      `${JSON.stringify(evidence, undefined, 2)}\n`,
    );
    return evidence;
  } finally {
    await Promise.all(
      sidecars.map(async (sidecar) => {
        await sidecar.terminate();
      }),
    );
    await rm(scratchDirectory, { force: true, recursive: true });
  }
}

function startSidecar(input: {
  readonly built: BuiltSidecar;
  readonly curlPath: string;
  readonly name: string;
  readonly scratchDirectory: string;
}): SidecarProcess & { startedAtMs: () => number } {
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
      `${fixturePath}:/fixture/minimal-valid-save.dat:ro`,
      "--volume",
      `${input.scratchDirectory}:/work`,
      "--volume",
      `${input.curlPath}:/test/curl:ro`,
      "--env",
      "PATH=/artifact/runtime/bin",
      "--env",
      "HOME=/work/home",
      "--env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
      "--env",
      "GIT_ATTR_NOSYSTEM=1",
      "--env",
      "GIT_TERMINAL_PROMPT=0",
      "--env",
      "LANG=C",
      "--env",
      "LC_ALL=C",
      cleanImage,
      `/artifact/runtime/bin/silksong-git-sidecar-${targetTriple}`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: DesktopSidecarProducedMessage[] = [];
  const queue: DesktopSidecarProducedMessage[] = [];
  const waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: DesktopSidecarProducedMessage) => void;
  }> = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBuffer = "";
  let parseError: Error | undefined;
  let exited = false;

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newline = stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const message = desktopSidecarOutputEnvelopeSchema.parse(
          JSON.parse(line),
        ) as DesktopSidecarProducedMessage;
        messages.push(message);
        const waiter = waiters.shift();
        if (waiter === undefined) {
          queue.push(message);
        } else {
          waiter.resolve(message);
        }
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
        const unresolved = waiters.splice(0);
        for (const waiter of unresolved) {
          waiter.reject(parseError);
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) =>
    stderrChunks.push(Buffer.from(chunk)),
  );
  const exit = waitForExit(child).finally(() => {
    exited = true;
    if (stdoutBuffer !== "" && parseError === undefined) {
      parseError = new Error("Sidecar stdout ended with a partial JSONL line.");
    }
    const unresolved = waiters.splice(0);
    for (const waiter of unresolved) {
      waiter.reject(parseError ?? new Error("Sidecar exited unexpectedly."));
    }
  });

  return {
    containerName: input.name,
    messages,
    stderr: () => Buffer.concat(stderrChunks).toString("utf8"),
    exit,
    startedAtMs: () => performance.now() - startedAt,
    send(message) {
      if (exited) {
        throw new Error("Cannot send to an exited sidecar.");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async readMessage() {
      const queued = queue.shift();
      if (queued !== undefined) {
        return queued;
      }
      if (parseError !== undefined) {
        throw parseError;
      }
      return await waitForMessage(waiters, 10_000);
    },
    async readResponse(requestId) {
      for (;;) {
        const message = await this.readMessage();
        if (message.kind !== "response" || message.requestId !== requestId) {
          continue;
        }
        if (!message.ok) {
          throw new Error(
            `Sidecar request ${requestId} failed: ${message.error.code}`,
          );
        }
        return message;
      }
    },
    async terminate() {
      if (exited) {
        return;
      }
      try {
        await runChecked("podman", ["kill", "--signal", "KILL", input.name]);
      } catch {
        // The container may have exited between the check and cleanup.
      }
      await exit.catch(() => undefined);
    },
  };
}

async function assertReady(sidecar: SidecarProcess) {
  const message = await sidecar.readMessage();
  if (message.kind !== "event" || message.event.type !== "process.ready") {
    throw new Error("Sidecar did not produce process.ready.");
  }
}

function command(requestId: string, value: Readonly<Record<string, unknown>>) {
  return {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "command",
    requestId,
    command: value,
  };
}

function assertResponseResultType<
  ResultType extends Extract<
    Extract<DesktopSidecarResponse, { readonly ok: true }>["result"],
    { readonly type: string }
  >["type"],
>(
  response: DesktopSidecarResponse,
  type: ResultType,
): asserts response is Extract<
  DesktopSidecarResponse,
  { readonly ok: true }
> & {
  readonly result: Extract<
    Extract<DesktopSidecarResponse, { readonly ok: true }>["result"],
    { readonly type: ResultType }
  >;
} {
  if (!response.ok || response.result.type !== type) {
    throw new Error(`Expected sidecar result ${type}.`);
  }
}

function readConnection(response: DesktopSidecarResponse) {
  if (!response.ok || response.result.type !== "session.opened") {
    throw new Error("Expected a session.opened response.");
  }
  return response.result.connection;
}

async function requestJson(
  sidecar: SidecarProcess,
  connection: { readonly bearerToken: string; readonly endpoint: string },
  requestPath: string,
  options: { readonly body?: string; readonly method?: string } = {},
) {
  const bytes = await requestBytes(sidecar, connection, requestPath, options);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid HTTP JSON response: ${String(error)}`);
  }
}

async function requestBytes(
  sidecar: SidecarProcess,
  connection: { readonly bearerToken: string; readonly endpoint: string },
  requestPath: string,
  options: { readonly body?: string; readonly method?: string } = {},
) {
  const args = [
    "exec",
    "--env",
    "PATH=/test",
    sidecar.containerName,
    "/test/curl",
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    "--header",
    `Authorization: Bearer ${connection.bearerToken}`,
  ];
  if (options.method !== undefined) {
    args.push("--request", options.method);
  }
  if (options.body !== undefined) {
    args.push(
      "--header",
      "Content-Type: application/json",
      "--data-raw",
      options.body,
    );
  }
  args.push(`${connection.endpoint}${requestPath}`);
  const result = await runCapture("podman", args);
  return result.stdout;
}

async function ensureCleanImage() {
  const existsResult = await runProcess("podman", [
    "image",
    "exists",
    cleanImage,
  ]);
  if (existsResult.code !== 0) {
    await runChecked("podman", ["pull", cleanImage]);
  }
  await runChecked("podman", [
    "run",
    "--rm",
    "--network=none",
    cleanImage,
    "sh",
    "-c",
    'test -z "$(command -v node || true)" && test -z "$(command -v git || true)"',
  ]);
}

async function prepareStaticCurl(): Promise<string> {
  const result = await runCapture("nix", [
    "build",
    "--no-link",
    "--print-out-paths",
    "nixpkgs#pkgsStatic.curl",
  ]);
  const storePath = result.stdout
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  let curlPath: string | undefined;
  for (const candidate of storePath) {
    const candidatePath = path.join(candidate, "bin/curl");
    try {
      const metadata = await stat(candidatePath);
      if (metadata.isFile()) {
        curlPath = candidatePath;
        break;
      }
    } catch {
      // Nix returns both the binary and man-page outputs for this derivation.
    }
  }
  if (curlPath === undefined) {
    throw new Error("Nix did not return a static curl binary path.");
  }
  return curlPath;
}

async function copyFixtureTo(destination: string) {
  await writeFile(destination, await readFile(fixturePath));
}

async function inspectArtifact(built: BuiltSidecar) {
  const manifest: unknown = JSON.parse(
    await readFile(built.manifestPath, "utf8"),
  );
  const expectedManifest = {
    layoutVersion: 1,
    layout: { type: "bundled" },
    sidecar: {
      type: "embeddedExecutable",
      path: ["bin", `silksong-git-sidecar-${targetTriple}`],
    },
    git: { path: ["bin", "git"] },
  };
  assertEqual(manifest, expectedManifest, "runtime manifest");

  const noticesDirectory = path.join(
    built.artifactDirectory,
    "runtime/notices",
  );
  const notices = (await readdir(noticesDirectory)).toSorted();
  assertEqual(
    notices,
    [
      "GIT-COPYING",
      "NODE-LICENSE",
      "PROTOTYPE-NOTICES.md",
      "STATIC-GIT-LICENSE",
    ],
    "notice inventory",
  );
  const [sidecarMetadata, gitMetadata, sidecarFile, gitFile, gitDynamic] =
    await Promise.all([
      stat(built.binaryPath),
      stat(built.gitPath),
      captureHost("file", [built.binaryPath]),
      captureHost("file", [built.gitPath]),
      captureHost("readelf", ["-d", built.gitPath]),
    ]);
  const gitVersion = await captureHost("git", ["--version"], {
    PATH: path.dirname(built.gitPath),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    LANG: "C",
    LC_ALL: "C",
  });
  assertEqual(gitVersion.trim(), "git version 2.55.0", "static Git version");
  const totalBytes = await directorySize(built.artifactDirectory);

  return {
    totalBytes,
    sidecarBytes: sidecarMetadata.size,
    gitBytes: gitMetadata.size,
    sidecarSha256: await sha256File(built.binaryPath),
    gitSha256: await sha256File(built.gitPath),
    sidecarFile: sidecarFile.trim(),
    gitFile: gitFile.trim(),
    gitHasDynamicDependency: gitDynamic.includes("(NEEDED)"),
    notices,
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
  return sha256(await readFile(filePath));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function captureHost(
  commandName: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  const result = await runCapture(commandName, args, extraEnvironment);
  return result.stdout.toString("utf8");
}

async function runChecked(commandName: string, args: readonly string[]) {
  const result = await runProcess(commandName, args);
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${commandName} failed with ${describeExit(result)}${result.stderr.length > 0 ? `: ${result.stderr.toString("utf8").trim()}` : ""}`,
    );
  }
}

async function runCapture(
  commandName: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<CapturedProcess> {
  const child = spawn(commandName, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const result = await waitForExit(child);
  return {
    ...result,
    stderr: Buffer.concat(stderr),
    stdout: Buffer.concat(stdout),
  };
}

async function runProcess(
  commandName: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<CapturedProcess> {
  return await runCapture(commandName, args, extraEnvironment);
}

async function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function waitForMessage(
  waiters: Array<{
    readonly reject: (error: Error) => void;
    readonly resolve: (message: DesktopSidecarProducedMessage) => void;
  }>,
  timeoutMs: number,
): Promise<DesktopSidecarProducedMessage> {
  return await new Promise((resolve, reject) => {
    let waiter: {
      readonly reject: (error: Error) => void;
      readonly resolve: (message: DesktopSidecarProducedMessage) => void;
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index !== -1) {
        waiters.splice(index, 1);
      }
      reject(new Error("Timed out waiting for a sidecar message."));
    }, timeoutMs);
    waiter = {
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    };
    waiters.push(waiter);
  });
}

function assertProtocolMessages(
  messages: readonly DesktopSidecarProducedMessage[],
) {
  for (const message of messages) {
    if (message.protocolVersion !== desktopSidecarProtocolVersion) {
      throw new Error("Sidecar protocol version changed during one process.");
    }
  }
}

function assertSuccessfulExit(exit: ProcessExit, label: string) {
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `${label} did not exit successfully: ${describeExit(exit)}.`,
    );
  }
}

function describeExit(exit: ProcessExit): string {
  return exit.signal === null
    ? `exit code ${String(exit.code)}`
    : `signal ${exit.signal}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object in the prototype response.");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an array.`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${label} to be a string.`);
  }
  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

function assertBufferEqual(actual: Buffer, expected: Buffer, label: string) {
  if (!actual.equals(expected)) {
    throw new Error(`${label} was not byte-for-byte exact.`);
  }
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
