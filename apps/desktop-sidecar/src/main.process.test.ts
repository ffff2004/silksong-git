import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  initSaveHistory,
  observeSave,
  queryRawObservations,
} from "@silksong-git/history";

import type { DesktopSidecarResponse } from "./protocol.ts";
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

async function setRepositoryFormatVersionFixture(
  repo: HistoryRepoFixture,
  repositoryFormatVersion: number | undefined,
) {
  // Fixture construction only: the public History Interface intentionally does not permit a test to
  // manufacture legacy, older, or newer durable formats.
  const configPath = path.join(repo.repoPath, ".silksong-git/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;

  if (repositoryFormatVersion === undefined) {
    delete config["repositoryFormatVersion"];
  } else {
    config["repositoryFormatVersion"] = repositoryFormatVersion;
  }

  await writeFile(configPath, `${JSON.stringify(config)}\n`);
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

function parseSuccessfulResponse(
  message: unknown,
): Extract<DesktopSidecarResponse, { readonly ok: true }> {
  const parsed = desktopSidecarOutputEnvelopeSchema.parse(message);
  if (parsed.kind !== "response" || !parsed.ok) {
    throw new Error("Expected a successful Desktop sidecar response.");
  }

  return parsed;
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
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    // eslint-disable-next-line unicorn/no-null
    requestId: null,
    ok: false,
    error: {
      code: "invalid_message",
      message: "The input line is not valid JSON.",
    },
  });

  sidecar.send(command("future-version", { type: "watcher.start" }, 7));
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
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

test("inspects only readable regular Encoded Saves regardless of filename", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-desktop-static-save-test-"),
  );
  t.after(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const renamedEncodedSave = path.join(temporaryDirectory, "custom-name.bin");
  const invalidEncodedSave = path.join(temporaryDirectory, "invalid.dat");
  await copyFile(minimalEncodedSavePath, renamedEncodedSave);
  await writeFile(invalidEncodedSave, "not an encoded save");

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("renamed-save", {
      type: "save.inspect",
      savePath: renamedEncodedSave,
    }),
  );
  const inspected = parseSuccessfulResponse(
    await readResponse(sidecar, "renamed-save"),
  );
  assert.equal(inspected.result.type, "save.inspected");
  assert.equal(typeof inspected.result.decodedSave, "object");

  sidecar.send(
    command("directory", {
      type: "save.inspect",
      savePath: temporaryDirectory,
    }),
  );
  assert.deepEqual(await readResponse(sidecar, "directory"), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "directory",
    ok: true,
    result: { type: "save.invalidFile" },
  });

  sidecar.send(
    command("bad-encoding", {
      type: "save.inspect",
      savePath: invalidEncodedSave,
    }),
  );
  assert.deepEqual(await readResponse(sidecar, "bad-encoding"), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "bad-encoding",
    ok: true,
    result: { type: "save.decodeFailed" },
  });

  await shutDown(sidecar);
});

test("initializes a repository and commits its baseline through the public protocol", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-desktop-sidecar-initialize-success-test-"),
  );
  t.after(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const watchedSavePath = path.join(temporaryDirectory, "watched-save.dat");
  const repoPath = path.join(temporaryDirectory, "history-repo");
  await copyFile(minimalEncodedSavePath, watchedSavePath);

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);
  sidecar.send(
    command("initialize", {
      type: "repository.initialize",
      repoPath,
      watchedSavePath,
    }),
  );

  const response = parseSuccessfulResponse(
    await readResponse(sidecar, "initialize"),
  );
  assert.deepEqual(response.result, {
    type: "repository.initializationResult",
    initialization: { status: "initialized" },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "started",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "finished",
    },
  });
  const history = await queryRawObservations({ repoPath });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0]?.observation.trigger, "watcher");

  await shutDown(sidecar);
});

test("reports a repository initialization failure through the public protocol", async (t) => {
  const repo = await createHistoryRepo(t);
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);
  sidecar.send(
    command("initialize-existing", {
      type: "repository.initialize",
      repoPath: repo.repoPath,
      watchedSavePath: repo.watchedSavePath,
    }),
  );

  const response = parseSuccessfulResponse(
    await readResponse(sidecar, "initialize-existing"),
  );
  assert.deepEqual(response.result, {
    type: "repository.initializationResult",
    initialization: {
      status: "failed",
      phase: "repository",
      reason: "historyFailed",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "started",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "finished",
    },
  });

  await shutDown(sidecar);
});

test("reports a baseline observation failure through the public protocol", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-desktop-sidecar-initialize-baseline-test-"),
  );
  t.after(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });
  const repoPath = path.join(temporaryDirectory, "history-repo");

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);
  sidecar.send(
    command("initialize-bad-baseline", {
      type: "repository.initialize",
      repoPath,
      // A directory is accepted as Project Config during initialization but cannot be observed as
      // an Encoded Save, allowing the protocol to exercise the baseline failure phase.
      watchedSavePath: temporaryDirectory,
    }),
  );

  const response = parseSuccessfulResponse(
    await readResponse(sidecar, "initialize-bad-baseline"),
  );
  assert.deepEqual(response.result, {
    type: "repository.initializationResult",
    initialization: {
      status: "failed",
      phase: "baseline",
      reason: "observationFailed",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "started",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "finished",
    },
  });
  const history = await queryRawObservations({ repoPath });
  assert.equal(history.entries.length, 0);

  await shutDown(sidecar);
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
    protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "start",
    ok: true,
    result: { type: "watcher.started" },
  });
  const observation = await sidecar.readMessage();
  assert.deepEqual(observation, {
    protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
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

test("inspects and confirms repository migration before opening a Repo Session", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo, undefined);

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("rebuild-legacy", {
      type: "repository.rebuild",
      repoPath: repo.repoPath,
    }),
  );
  assert.deepEqual(await readResponse(sidecar, "rebuild-legacy"), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "rebuild-legacy",
    ok: false,
    error: {
      code: "repository_rebuild_failed",
      message: "The Semantic Read Model could not be rebuilt.",
    },
  });

  sidecar.send(
    command("open-legacy", { type: "session.open", repoPath: repo.repoPath }),
  );
  assert.deepEqual(await readResponse(sidecar, "open-legacy"), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "open-legacy",
    ok: false,
    error: {
      code: "session_open_failed",
      message: "The Repo Session could not be opened.",
    },
  });

  sidecar.send(
    command("inspect", { type: "repository.inspect", repoPath: repo.repoPath }),
  );
  const inspected = parseSuccessfulResponse(
    await readResponse(sidecar, "inspect"),
  );
  assert.equal(inspected.result.type, "repository.inspected");
  assert.equal(inspected.result.inspection.status, "legacyConfig");

  sidecar.send(
    command("migrate", {
      type: "repository.migrate",
      repoPath: repo.repoPath,
      inspectionId: inspected.result.inspection.inspectionId,
      confirmation: "migrate-save-history-repository",
    }),
  );
  const migration = parseSuccessfulResponse(
    await readResponse(sidecar, "migrate"),
  );
  assert.equal(migration.result.type, "repository.migrationResult");
  assert.equal(migration.result.migration.status, "migrated");
  assert.equal(migration.result.migration.sourceState, "migrated");
  assert.deepEqual(migration.result.migration.snapshotState, {
    status: "notCreated",
  });

  sidecar.send(
    command("open-current", { type: "session.open", repoPath: repo.repoPath }),
  );
  const opened = parseSuccessfulResponse(
    await readResponse(sidecar, "open-current"),
  );
  assert.equal(opened.result.type, "session.opened");
  await shutDown(sidecar);
});

test("compares Watched Saves through legacy and migration-compatible configs", async (t) => {
  const repo = await createHistoryRepo(t);
  const alternateSavePath = path.join(
    path.dirname(repo.watchedSavePath),
    "alternate-save.dat",
  );
  await copyFile(minimalEncodedSavePath, alternateSavePath);

  for (const repositoryFormatVersion of [undefined, 0]) {
    await setRepositoryFormatVersionFixture(repo, repositoryFormatVersion);
    const sidecar = spawnSidecar(t);
    await readReady(sidecar);

    sidecar.send(
      command(`compare-same-${repositoryFormatVersion ?? "legacy"}`, {
        type: "repository.compareWatchedSave",
        repoPath: repo.repoPath,
        savePath: repo.watchedSavePath,
      }),
    );
    const same = parseSuccessfulResponse(
      await readResponse(
        sidecar,
        `compare-same-${repositoryFormatVersion ?? "legacy"}`,
      ),
    );
    assert.equal(same.result.type, "repository.watchedSaveCompared");
    assert.equal(same.result.same, true);

    sidecar.send(
      command(`compare-different-${repositoryFormatVersion ?? "legacy"}`, {
        type: "repository.compareWatchedSave",
        repoPath: repo.repoPath,
        savePath: alternateSavePath,
      }),
    );
    const different = parseSuccessfulResponse(
      await readResponse(
        sidecar,
        `compare-different-${repositoryFormatVersion ?? "legacy"}`,
      ),
    );
    assert.equal(different.result.type, "repository.watchedSaveCompared");
    assert.equal(different.result.same, false);

    await shutDown(sidecar);
  }
});

test("holds the Desktop migration operation between verified snapshot publication and commit", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo, undefined);
  const archivePath = path.join(path.dirname(repo.repoPath), "archive");
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("inspect-migration", {
      type: "repository.inspect",
      repoPath: repo.repoPath,
    }),
  );
  const inspection = parseSuccessfulResponse(
    await readResponse(sidecar, "inspect-migration"),
  );
  assert.equal(inspection.result.type, "repository.inspected");

  sidecar.send(
    command("prepare-migration", {
      type: "repository.migration.prepare",
      repoPath: repo.repoPath,
      inspectionId: inspection.result.inspection.inspectionId,
      confirmation: "migrate-save-history-repository",
      snapshotPath: archivePath,
    }),
  );
  const prepared = parseSuccessfulResponse(
    await readResponse(sidecar, "prepare-migration"),
  );
  assert.equal(prepared.result.type, "repository.migrationPrepared");
  assert.equal(prepared.result.preparation.status, "prepared");
  assert.equal(prepared.result.preparation.snapshot.repoPath, archivePath);
  assert.match(
    prepared.result.preparation.snapshot.directoryDigest,
    /^[0-9a-f]{64}$/v,
  );
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "repositoryMigration",
      status: "started",
    },
  });
  await assert.doesNotReject(async () => await stat(archivePath));

  const repoDirectory = path.dirname(repo.repoPath);
  const initializeRepoPath = path.join(repoDirectory, "managed-repository");
  sidecar.send(
    command("initialize-during-migration", {
      type: "repository.initialize",
      repoPath: initializeRepoPath,
      watchedSavePath: repo.watchedSavePath,
    }),
  );
  const initializeDuringMigration = await readResponse(
    sidecar,
    "initialize-during-migration",
  );
  assert.deepEqual(initializeDuringMigration, {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "initialize-during-migration",
    ok: false,
    error: {
      code: "repository_initialize_failed",
      message:
        "The repository cannot initialize while a repository migration is in progress.",
    },
  });

  sidecar.send(
    command("commit-migration", { type: "repository.migration.commit" }),
  );
  const committed = parseSuccessfulResponse(
    await readResponse(sidecar, "commit-migration"),
  );
  assert.equal(committed.result.type, "repository.migrationResult");
  assert.equal(committed.result.migration.status, "migrated");
  assert.equal(committed.result.migration.sourceState, "migrated");
  assert.deepEqual(committed.result.migration.snapshotState, {
    repoPath: archivePath,
    status: "retained",
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "repositoryMigration",
      status: "finished",
    },
  });

  await shutDown(sidecar);
});

test("abnormal sidecar cleanup releases a prepared migration lease", async (t) => {
  const repo = await createHistoryRepo(t);
  await setRepositoryFormatVersionFixture(repo, undefined);
  const archivePath = path.join(path.dirname(repo.repoPath), "archive");
  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  sidecar.send(
    command("inspect", { type: "repository.inspect", repoPath: repo.repoPath }),
  );
  const inspection = parseSuccessfulResponse(
    await readResponse(sidecar, "inspect"),
  );
  assert.equal(inspection.result.type, "repository.inspected");

  sidecar.send(
    command("prepare", {
      type: "repository.migration.prepare",
      repoPath: repo.repoPath,
      inspectionId: inspection.result.inspection.inspectionId,
      confirmation: "migrate-save-history-repository",
      snapshotPath: archivePath,
    }),
  );
  const prepared = parseSuccessfulResponse(
    await readResponse(sidecar, "prepare"),
  );
  assert.equal(prepared.result.type, "repository.migrationPrepared");
  assert.equal(prepared.result.preparation.status, "prepared");

  sidecar.closeInput();
  assert.deepEqual(
    await withTimeout(
      sidecar.waitForExit(),
      10_000,
      "Timed out waiting for sidecar cleanup.",
    ),
    { code: 1, signal: undefined },
  );

  const replacement = spawnSidecar(t);
  await readReady(replacement);
  replacement.send(
    command("replacement-inspect", {
      type: "repository.inspect",
      repoPath: repo.repoPath,
    }),
  );
  const replacementInspection = parseSuccessfulResponse(
    await readResponse(replacement, "replacement-inspect"),
  );
  if (replacementInspection.result.type !== "repository.inspected") {
    throw new Error("Expected a replacement repository inspection.");
  }
  assert.equal(replacementInspection.result.inspection.status, "legacyConfig");
  replacement.send(
    command("replacement-prepare", {
      type: "repository.migration.prepare",
      repoPath: repo.repoPath,
      inspectionId: replacementInspection.result.inspection.inspectionId,
      confirmation: "migrate-save-history-repository",
      snapshotPath: archivePath,
    }),
  );
  const replacementPrepared = parseSuccessfulResponse(
    await readResponse(replacement, "replacement-prepare"),
  );
  if (replacementPrepared.result.type !== "repository.migrationPrepared") {
    throw new Error("Expected a replacement migration preparation.");
  }
  assert.equal(replacementPrepared.result.preparation.status, "prepared");

  replacement.send(
    command("replacement-commit", {
      type: "repository.migration.commit",
    }),
  );
  const committed = parseSuccessfulResponse(
    await readResponse(replacement, "replacement-commit"),
  );
  if (committed.result.type !== "repository.migrationResult") {
    throw new Error("Expected a replacement migration result.");
  }
  assert.equal(committed.result.migration.status, "migrated");
  await shutDown(replacement);
});

test("refuses sidecar rebuilds for older and newer durable formats", async (t) => {
  const olderRepo = await createHistoryRepo(t);
  const newerRepo = await createHistoryRepo(t);
  await setRepositoryFormatVersionFixture(olderRepo, 0);
  await setRepositoryFormatVersionFixture(newerRepo, 2);

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);

  for (const [requestId, repo] of [
    ["rebuild-older", olderRepo],
    ["rebuild-newer", newerRepo],
  ] as const) {
    sidecar.send(
      command(requestId, {
        type: "repository.rebuild",
        repoPath: repo.repoPath,
      }),
    );
    assert.deepEqual(await readResponse(sidecar, requestId), {
      protocolVersion: desktopSidecarProtocolVersion,
      kind: "response",
      requestId,
      ok: false,
      error: {
        code: "repository_rebuild_failed",
        message: "The Semantic Read Model could not be rebuilt.",
      },
    });
    assert.deepEqual(await sidecar.readMessage(), {
      protocolVersion: desktopSidecarProtocolVersion,
      kind: "event",
      event: {
        type: "mutation.activity",
        mutation: "repositoryRebuild",
        status: "started",
      },
    });
    assert.deepEqual(await sidecar.readMessage(), {
      protocolVersion: desktopSidecarProtocolVersion,
      kind: "event",
      event: {
        type: "mutation.activity",
        mutation: "repositoryRebuild",
        status: "finished",
      },
    });
  }

  await shutDown(sidecar);
});

test("rebuilds a Semantic Read Model through the sidecar before opening a Repo Session", async (t) => {
  const repo = await createHistoryRepo(t);
  await observeSave({ repoPath: repo.repoPath });
  const rawBefore = await queryRawObservations({ repoPath: repo.repoPath });
  await rm(path.join(repo.repoPath, ".silksong-git/read-model.sqlite"));

  const sidecar = spawnSidecar(t);
  await readReady(sidecar);
  sidecar.send(
    command("inspect-rebuild", {
      type: "repository.inspect",
      repoPath: repo.repoPath,
    }),
  );
  const inspection = parseSuccessfulResponse(
    await readResponse(sidecar, "inspect-rebuild"),
  );
  assert.equal(inspection.result.type, "repository.inspected");
  assert.equal(inspection.result.inspection.status, "rebuildRequired");

  sidecar.send(
    command("rebuild", {
      type: "repository.rebuild",
      repoPath: repo.repoPath,
    }),
  );
  const rebuilt = parseSuccessfulResponse(
    await readResponse(sidecar, "rebuild"),
  );
  assert.equal(rebuilt.result.type, "repository.rebuilt");
  assert.equal(rebuilt.result.rebuild.observationCount, 1);
  assert.deepEqual(rebuilt.result.repository, {
    status: "ready",
    requiredAction: "open",
    capabilities: ["read", "observe", "restore", "rebuildReadModel", "watch"],
  });
  assert.equal("inspectionId" in rebuilt.result.repository, false);
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "repositoryRebuild",
      status: "started",
    },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event: {
      type: "mutation.activity",
      mutation: "repositoryRebuild",
      status: "finished",
    },
  });

  const rawAfter = await queryRawObservations({ repoPath: repo.repoPath });
  assert.deepEqual(rawAfter, rawBefore);

  sidecar.send(
    command("open-after-rebuild", {
      type: "session.open",
      repoPath: repo.repoPath,
    }),
  );
  const opened = parseSuccessfulResponse(
    await readResponse(sidecar, "open-after-rebuild"),
  );
  assert.equal(opened.result.type, "session.opened");
  await shutDown(sidecar);
});

test("compatible consumers can ignore an unknown future event fixture", () => {
  const futureEvent = {
    protocolVersion: desktopSidecarProtocolVersion,
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
      protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId: "shutdown-active",
    ok: true,
    result: { type: "process.shutdownComplete" },
  });
  assert.deepEqual(await sidecar.readMessage(), {
    protocolVersion: desktopSidecarProtocolVersion,
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
    protocolVersion: desktopSidecarProtocolVersion,
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
