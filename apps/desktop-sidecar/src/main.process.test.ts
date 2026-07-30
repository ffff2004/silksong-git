import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { initSaveHistory, queryRawObservations } from "@silksong-git/history";

import {
  desktopSidecarOutputEnvelopeSchema,
  desktopSidecarProtocolVersion,
} from "./protocol.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sidecarEntryPoint = path.join(
  repoRoot,
  "apps/desktop-sidecar/dist/main.js",
);
const fixtureDirectory = path.join(
  repoRoot,
  "packages/core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const maskShard2CollectedEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-save.dat",
);

interface HistoryRepoFixture {
  readonly repoPath: string;
  readonly watchedSavePath: string;
}

interface SpawnedSidecar {
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnArguments: readonly string[];
  send: (message: unknown) => void;
  sendLine: (line: string) => void;
  closeInput: () => void;
  readMessage: () => Promise<unknown>;
  waitForExit: () => Promise<{
    readonly code?: number;
    readonly signal?: NodeJS.Signals;
  }>;
}

async function createHistoryRepo(
  t: TestContext,
  config?: {
    readonly capturePolicy: {
      readonly debounceWriteMs: number;
      readonly minCommitIntervalMs: number;
    };
  },
): Promise<HistoryRepoFixture> {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-desktop-sidecar-test-"),
  );
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");
  const repoPath = path.join(tempDirectory, "history-repo");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
    ...(config !== undefined && { config }),
  });

  return { repoPath, watchedSavePath };
}

function spawnSidecar(t: TestContext): SpawnedSidecar {
  const child = spawn(process.execPath, [sidecarEntryPoint], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  const lineWaiters: Array<ReturnType<typeof Promise.withResolvers<string>>> =
    [];
  const exit = Promise.withResolvers<{
    readonly code?: number;
    readonly signal?: NodeJS.Signals;
  }>();
  let stdout = "";
  let stdoutBuffer = "";
  let stderr = "";
  let exited = false;

  t.after(() => {
    if (!exited) {
      child.kill("SIGKILL");
    }
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    stdoutBuffer += chunk;
    drainLines();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("exit", (code, signal) => {
    exited = true;
    exit.resolve({
      code: code ?? undefined,
      signal: signal ?? undefined,
    });
    const unresolvedWaiters = [...lineWaiters];
    lineWaiters.length = 0;
    for (const waiter of unresolvedWaiters) {
      waiter.reject(new Error("Sidecar exited before another message."));
    }
  });
  child.on("error", exit.reject);

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    spawnArguments: child.spawnargs,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendLine(line) {
      child.stdin.write(`${line}\n`);
    },
    closeInput() {
      child.stdin.end();
    },
    async readMessage() {
      const line = lines.shift() ?? (await waitForLine());
      return JSON.parse(line) as unknown;
    },
    waitForExit: async () => await exit.promise,
  };

  function drainLines() {
    let newlineIndex = stdoutBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      const waiter = lineWaiters.shift();

      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (waiter === undefined) {
        lines.push(line);
      } else {
        waiter.resolve(line);
      }

      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  }

  async function waitForLine() {
    const waiter = Promise.withResolvers<string>();
    lineWaiters.push(waiter);
    return await withTimeout(
      waiter.promise,
      10_000,
      "Timed out waiting for a sidecar message.",
    );
  }
}

function command(
  requestId: string,
  value: Readonly<Record<string, unknown>>,
  protocolVersion: number = desktopSidecarProtocolVersion,
) {
  return {
    protocolVersion,
    kind: "command",
    requestId,
    command: value,
  };
}

async function readReady(sidecar: SpawnedSidecar) {
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: { type: "process.ready" },
  });
}

async function readResponse(
  sidecar: SpawnedSidecar,
  requestId: string,
): Promise<unknown> {
  for (;;) {
    const message = await sidecar.readMessage();
    if (
      typeof message === "object"
      && message !== null
      && "kind" in message
      && message.kind === "response"
      && "requestId" in message
      && message.requestId === requestId
    ) {
      return message;
    }
  }
}

async function shutDown(sidecar: SpawnedSidecar, requestId = "shutdown") {
  sidecar.send(command(requestId, { type: "process.shutdown" }));
  const response = await readResponse(sidecar, requestId);

  assert.deepEqual(response, {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId,
    ok: true,
    result: { type: "process.shutdownComplete" },
  });
  assert.deepEqual(
    await withTimeout(
      sidecar.waitForExit(),
      10_000,
      "Timed out waiting for graceful sidecar exit.",
    ),
    { code: 0, signal: undefined },
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error(message));
  }, timeoutMs);

  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

test("uses strict JSONL framing and structured command failures", async (t) => {
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.sendLine("{not-json");
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: 1,
    kind: "response",
    // eslint-disable-next-line unicorn/no-null
    requestId: null,
    ok: false,
    error: {
      code: "invalid_message",
      message: "The input line is not valid JSON.",
    },
  });

  sidecar.send(command("future-version", { type: "watcher.start" }, 2));
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: 1,
    kind: "response",
    requestId: "future-version",
    ok: false,
    error: {
      code: "unsupported_protocol_version",
      message: "The command uses an unsupported protocol version.",
    },
  });

  sidecar.send(command("unknown", { type: "history.query" }));
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: 1,
    kind: "response",
    requestId: "unknown",
    ok: false,
    error: {
      code: "unknown_command",
      message: "The command type is not supported.",
    },
  });

  sidecar.send(
    command("invalid-shutdown", {
      type: "process.shutdown",
      unexpected: true,
    }),
  );
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: 1,
    kind: "response",
    requestId: "invalid-shutdown",
    ok: false,
    error: {
      code: "invalid_command",
      message: "The process.shutdown command is invalid.",
    },
  });

  await shutDown(sidecar);
  assert.equal(sidecar.stderr, "");
  for (const line of sidecar.stdout.trim().split("\n")) {
    assert.doesNotThrow(() =>
      desktopSidecarOutputEnvelopeSchema.parse(JSON.parse(line)),
    );
  }
});

test("opens one session, delivers its credential once, and controls watching", async (t) => {
  const repo = await createHistoryRepo(t);
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("open", { type: "session.open", repoPath: repo.repoPath }),
  );
  const opened = desktopSidecarOutputEnvelopeSchema.parse(
    await readResponse(sidecar, "open"),
  );
  assert.equal(opened.kind, "response");
  assert.equal(opened.ok, true);
  assert.equal(opened.result.type, "session.opened");
  assert.ok("connection" in opened.result);
  const { connection } = opened.result;
  assert.match(connection.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/v);
  assert.match(connection.bearerToken, /^[\w\-]{43}$/v);

  const watcherProbe = await fetch(`${connection.endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${connection.bearerToken}` },
  });
  assert.equal(watcherProbe.status, 200);
  assert.equal(
    ((await watcherProbe.json()) as { readonly status?: unknown }).status,
    "inactive",
  );

  sidecar.send(
    command("open-again", { type: "session.open", repoPath: repo.repoPath }),
  );
  assert.deepEqual(await readResponse(sidecar, "open-again"), {
    protocolVersion: 1,
    kind: "response",
    requestId: "open-again",
    ok: false,
    error: {
      code: "session_already_open",
      message: "This process already owns a Repo Session.",
    },
  });

  sidecar.send(command("start", { type: "watcher.start" }));
  assert.deepEqual(await readResponse(sidecar, "start"), {
    protocolVersion: 1,
    kind: "response",
    requestId: "start",
    ok: true,
    result: { type: "watcher.started" },
  });
  const observation = await sidecar.readMessage();
  assert.deepEqual(observation, {
    protocolVersion: 1,
    kind: "event",
    event: {
      type: "watcher.observation",
      cause: "startup",
      status: "committed",
      eventCount: 0,
      semanticStatus: "updated",
    },
  });

  sidecar.send(command("stop", { type: "watcher.stop" }));
  assert.deepEqual(await readResponse(sidecar, "stop"), {
    protocolVersion: 1,
    kind: "response",
    requestId: "stop",
    ok: true,
    result: { type: "watcher.stopped" },
  });

  await shutDown(sidecar);
  assert.equal(sidecar.stderr, "");
  assert.equal(
    sidecar.stdout.split(connection.bearerToken).length - 1,
    1,
    "credential must occur only in session.opened",
  );
  assert.equal(sidecar.spawnArguments.includes(repo.repoPath), false);
});

test("compatible consumers can ignore an unknown future event fixture", () => {
  const futureEvent = {
    protocolVersion: 1,
    kind: "event",
    event: {
      type: "watcher.capabilityAdded",
      capability: "future",
      detail: { arbitrary: true },
    },
  };

  const parsed = desktopSidecarOutputEnvelopeSchema.parse(futureEvent);
  assert.equal(parsed.kind, "event");
  assert.equal(parsed.event.type, "watcher.capabilityAdded");

  assert.throws(() =>
    desktopSidecarOutputEnvelopeSchema.parse({
      protocolVersion: 1,
      kind: "event",
      event: {
        type: "watcher.observation",
        cause: "startup",
        status: "committed",
      },
    }),
  );
});

test("graceful shutdown drains an active watcher observation", async (t) => {
  const repo = await createHistoryRepo(t, {
    capturePolicy: {
      debounceWriteMs: 0,
      minCommitIntervalMs: 0,
    },
  });
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("open", { type: "session.open", repoPath: repo.repoPath }),
  );
  const opened = desktopSidecarOutputEnvelopeSchema.parse(
    await readResponse(sidecar, "open"),
  );
  assert.equal(opened.kind, "response");
  assert.equal(opened.ok, true);
  assert.equal(opened.result.type, "session.opened");
  assert.ok("connection" in opened.result);
  const { connection } = opened.result;

  sidecar.send(command("start", { type: "watcher.start" }));
  await readResponse(sidecar, "start");
  await sidecar.readMessage();

  await copyFile(maskShard2CollectedEncodedSavePath, repo.watchedSavePath);
  await waitForWatcherActivity(connection, "observing");

  sidecar.send(command("shutdown-active", { type: "process.shutdown" }));
  assert.deepEqual(await readResponse(sidecar, "shutdown-active"), {
    protocolVersion: 1,
    kind: "response",
    requestId: "shutdown-active",
    ok: true,
    result: { type: "process.shutdownComplete" },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: 1,
    kind: "event",
    event: {
      type: "watcher.observation",
      cause: "change",
      status: "committed",
      eventCount: 1,
      semanticStatus: "updated",
    },
  });
  assert.deepEqual(await sidecar.waitForExit(), {
    code: 0,
    signal: undefined,
  });

  const history = await queryRawObservations({ repoPath: repo.repoPath });
  assert.equal(history.entries.length, 2);
});

test("graceful shutdown waits for an admitted HTTP mutation", async (t) => {
  const repo = await createHistoryRepo(t);
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("open-http-drain", {
      type: "session.open",
      repoPath: repo.repoPath,
    }),
  );
  const opened = desktopSidecarOutputEnvelopeSchema.parse(
    await readResponse(sidecar, "open-http-drain"),
  );
  assert.equal(opened.kind, "response");
  assert.equal(opened.ok, true);
  assert.equal(opened.result.type, "session.opened");
  assert.ok("connection" in opened.result);
  const { connection } = opened.result;
  const authorization = {
    Authorization: `Bearer ${connection.bearerToken}`,
    "Content-Type": "application/json",
  };
  const baselineResponse = await fetch(
    `${connection.endpoint}/api/v1/checkpoints`,
    {
      method: "POST",
      headers: authorization,
      body: "{}",
    },
  );
  assert.equal(baselineResponse.status, 200);
  assert.equal(
    ((await baselineResponse.json()) as { readonly status?: unknown }).status,
    "committed",
  );
  const baselineHistory = await queryRawObservations({
    repoPath: repo.repoPath,
  });
  assert.equal(baselineHistory.entries.length, 1);

  const endpoint = new URL(connection.endpoint);
  const checkpointBody = JSON.stringify({ allowUnchanged: true });
  const socket = createConnection({
    host: endpoint.hostname,
    port: Number(endpoint.port),
  });
  t.after(() => {
    socket.destroy();
  });
  await once(socket, "connect");

  let httpResponse = "";
  socket.on("data", (chunk: Buffer) => {
    httpResponse += chunk.toString("utf8");
  });
  socket.write(
    [
      "POST /api/v1/checkpoints HTTP/1.1",
      `Host: ${endpoint.host}`,
      `Authorization: ${authorization.Authorization}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(checkpointBody)}`,
      "Connection: close",
      "Expect: 100-continue",
      "",
      "",
    ].join("\r\n"),
  );
  while (!httpResponse.includes("100 Continue")) {
    await once(socket, "data");
  }

  sidecar.send(command("shutdown-http-drain", { type: "process.shutdown" }));
  const shutdownResponse = readResponse(sidecar, "shutdown-http-drain");
  const processExit = sidecar.waitForExit();

  await assertPromisePending(
    shutdownResponse,
    "shutdown response must wait for admitted HTTP work",
  );
  await assertPromisePending(
    processExit,
    "process exit must wait for admitted HTTP work",
  );

  const socketClosed = once(socket, "close");
  socket.end(checkpointBody);
  await socketClosed;
  assert.deepEqual(await shutdownResponse, {
    protocolVersion: 1,
    kind: "response",
    requestId: "shutdown-http-drain",
    ok: true,
    result: { type: "process.shutdownComplete" },
  });
  assert.deepEqual(await processExit, { code: 0, signal: undefined });

  const history = await queryRawObservations({ repoPath: repo.repoPath });
  assert.equal(history.entries.length, 2);
  assert.deepEqual(
    history.entries.map((entry) => entry.observation.trigger),
    ["manualCheckpoint", "manualCheckpoint"],
  );
  const [latest, baseline] = history.entries;
  assert.ok(latest !== undefined);
  assert.ok(baseline !== undefined);
  assert.notEqual(
    latest.observation.commit.ref,
    baseline.observation.commit.ref,
  );
  assert.equal(
    latest.observation.encodedSha256,
    baseline.observation.encodedSha256,
    "allowUnchanged must commit a second observation of the same save bytes",
  );
});

test("EOF is distinguishable from an acknowledged graceful shutdown", async (t) => {
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);
  sidecar.closeInput();

  assert.deepEqual(
    await withTimeout(
      sidecar.waitForExit(),
      10_000,
      "Timed out waiting for unexpected sidecar exit.",
    ),
    { code: 1, signal: undefined },
  );
  assert.equal(
    sidecar.stderr,
    "[desktop-sidecar] Desktop sidecar stopped without a graceful shutdown.\n",
  );
  assert.equal(sidecar.stdout.includes("process.shutdownComplete"), false);
});

async function waitForWatcherActivity(
  connection: {
    readonly endpoint: string;
    readonly bearerToken: string;
  },
  expectedActivity: string,
) {
  await withTimeout(
    (async () => {
      let activity: unknown;
      do {
        const response = await fetch(`${connection.endpoint}/api/v1/watcher`, {
          headers: { Authorization: `Bearer ${connection.bearerToken}` },
        });
        const { activity: currentActivity } = (await response.json()) as {
          readonly activity?: unknown;
        };
        activity = currentActivity;
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      } while (activity !== expectedActivity);
    })(),
    10_000,
    `Timed out waiting for watcher activity ${expectedActivity}.`,
  );
}

async function assertPromisePending(
  promise: Promise<unknown>,
  message: string,
) {
  const outcome = await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => {
        resolve("pending");
      }, 50);
    }),
  ]);

  assert.equal(outcome, "pending", message);
}
