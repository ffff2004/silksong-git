import { strict as assert } from "node:assert";
import type { ExecException } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cliEntryPoint = path.join(repoRoot, "apps/cli/dist/main.js");
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
const skipChildSigtermTestsOnWindows =
  process.platform === "win32"
    ? "child.kill('SIGTERM') terminates Node child processes on Windows instead of delivering a catchable signal"
    : false;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliHistoryRepoFixture {
  readonly watchedSavePath: string;
  readonly repoPath: string;
}

interface SpawnedCli {
  readonly stdout: string;
  readonly stderr: string;
  kill: (signal: NodeJS.Signals) => void;
  closeStdout: () => void;
  readStdoutLine: () => Promise<string>;
  waitForStderrIncludes: (text: string) => Promise<void>;
  waitForExit: () => Promise<{
    readonly code?: number;
    readonly signal?: NodeJS.Signals;
  }>;
}

async function runBuiltCli(args: readonly string[]): Promise<CliResult> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntryPoint, ...args],
      {
        cwd: repoRoot,
      },
      (error: ExecException | null, stdout, stderr) => {
        resolve({
          exitCode: getExitCode(error),
          stdout,
          stderr,
        });
      },
    );
  });
}

function spawnBuiltCli(args: readonly string[]): SpawnedCli {
  const child = spawn(process.execPath, [cliEntryPoint, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: repoRoot,
  });
  const stdoutLines: string[] = [];
  const stdoutLineWaiters: Array<(line: string) => void> = [];
  const stderrWaiters: Array<{
    readonly text: string;
    readonly resolve: (value: undefined) => void;
  }> = [];
  const exit = Promise.withResolvers<{
    readonly code?: number;
    readonly signal?: NodeJS.Signals;
  }>();
  let stdout = "";
  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    stdoutBuffer += chunk;
    drainStdoutLines();
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    notifyStderrWaiters();
  });
  child.on("exit", (code, signal) => {
    exit.resolve({
      code: code ?? undefined,
      signal: signal ?? undefined,
    });
  });
  child.on("error", exit.reject);

  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    kill(signal: NodeJS.Signals) {
      child.kill(signal);
    },
    closeStdout() {
      child.stdout.destroy();
    },
    async readStdoutLine() {
      const line = stdoutLines.shift();

      if (line !== undefined) {
        return line;
      }

      const waiter = Promise.withResolvers<string>();

      stdoutLineWaiters.push(waiter.resolve);

      return await waiter.promise;
    },
    async waitForStderrIncludes(text: string) {
      if (stderr.includes(text)) {
        return;
      }

      const waiter = Promise.withResolvers<undefined>();

      stderrWaiters.push({
        text,
        resolve: waiter.resolve,
      });

      await waiter.promise;
    },
    waitForExit: async () => await exit.promise,
  };

  function drainStdoutLines() {
    let newlineIndex = stdoutBuffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      const waiter = stdoutLineWaiters.shift();

      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (waiter === undefined) {
        stdoutLines.push(line);
      } else {
        waiter(line);
      }

      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  }

  function notifyStderrWaiters() {
    let index = 0;

    while (index < stderrWaiters.length) {
      const waiter = stderrWaiters[index];

      if (waiter === undefined || !stderr.includes(waiter.text)) {
        index++;
        continue;
      }

      stderrWaiters.splice(index, 1);
      waiter.resolve(undefined);
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const timeoutResult = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    timeoutResult.reject(new Error(description));
  }, timeoutMs);

  try {
    return await Promise.race([promise, timeoutResult.promise]);
  } finally {
    clearTimeout(timeout);
  }
}

function getExitCode(error: ExecException | null): number {
  if (error === null) {
    return 0;
  }

  return typeof error.code === "number" ? error.code : 1;
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-cli-process-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

async function createCliHistoryRepo(
  t: TestContext,
): Promise<CliHistoryRepoFixture> {
  const tempDirectory = await createTempDirectory(t);
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");
  const repoPath = path.join(tempDirectory, "history-repo");

  await writeFile(watchedSavePath, await readFile(minimalEncodedSavePath));
  const initResult = await runBuiltCli([
    "repo",
    "init",
    "--save",
    watchedSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(initResult.exitCode, 0);
  assert.equal(initResult.stderr, "");

  return {
    watchedSavePath,
    repoPath,
  };
}

test(
  "watch start --jsonl emits JSON Lines and exits cleanly on SIGTERM",
  { skip: skipChildSigtermTestsOnWindows },
  async (t) => {
    const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);
    const cli = spawnBuiltCli([
      "watch",
      "start",
      "--repo",
      repoPath,
      "--jsonl",
    ]);

    t.after(() => {
      cli.kill("SIGTERM");
    });

    const started = JSON.parse(
      await withTimeout(
        cli.readStdoutLine(),
        5000,
        "timed out waiting for started JSONL event",
      ),
    ) as {
      readonly type?: unknown;
      readonly repoPath?: unknown;
      readonly watchedSavePath?: unknown;
      readonly capturePolicy?: unknown;
    };
    const observation = JSON.parse(
      await withTimeout(
        cli.readStdoutLine(),
        5000,
        "timed out waiting for observation JSONL event",
      ),
    ) as {
      readonly type?: unknown;
      readonly repoPath?: unknown;
      readonly cause?: unknown;
      readonly status?: unknown;
      readonly result?: unknown;
    };

    assert.deepEqual(started, {
      type: "started",
      repoPath,
      watchedSavePath,
      capturePolicy: {
        debounceWriteMs: 500,
        minCommitIntervalMs: 0,
      },
    });
    assert.equal(observation.type, "observation");
    assert.equal(observation.repoPath, repoPath);
    assert.equal(observation.cause, "startup");
    assert.equal(observation.status, "committed");
    assert.equal("result" in observation, false);

    cli.kill("SIGTERM");
    const exit = await withTimeout(
      cli.waitForExit(),
      5000,
      "timed out waiting for watch command to exit after SIGTERM",
    );

    assert.equal(exit.code, 0);
    assert.equal(exit.signal, undefined);
    assert.equal(cli.stderr, "");
  },
);

test(
  "watch start --http reports usable credentials once and shuts down cleanly",
  { skip: skipChildSigtermTestsOnWindows },
  async (t) => {
    const { repoPath } = await createCliHistoryRepo(t);
    const cli = spawnBuiltCli([
      "watch",
      "start",
      "--repo",
      repoPath,
      "--http",
      "--jsonl",
    ]);

    t.after(() => {
      cli.kill("SIGTERM");
    });

    const started = JSON.parse(
      await withTimeout(
        cli.readStdoutLine(),
        5000,
        "timed out waiting for HTTP watch started event",
      ),
    ) as {
      readonly type?: unknown;
      readonly http?: {
        readonly endpoint?: unknown;
        readonly token?: unknown;
      };
    };

    assert.equal(started.type, "started");
    assert.equal(typeof started.http?.endpoint, "string");
    assert.equal(typeof started.http?.token, "string");
    const endpoint = String(started.http?.endpoint);
    const token = String(started.http?.token);
    const meta = await fetch(`${endpoint}/api/v1/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(meta.status, 200);

    const observationLine = await withTimeout(
      cli.readStdoutLine(),
      5000,
      "timed out waiting for HTTP watch observation event",
    );

    assert.equal(observationLine.includes(token), false);
    cli.kill("SIGTERM");
    const exit = await withTimeout(
      cli.waitForExit(),
      5000,
      "timed out waiting for HTTP watch shutdown",
    );

    assert.equal(exit.code, 0);
    assert.equal(cli.stdout.split(token).length - 1, 1);
  },
);

test("watch start stops and exits with failure when JSONL output fails", async (t) => {
  const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);
  const cli = spawnBuiltCli(["watch", "start", "--repo", repoPath, "--jsonl"]);

  t.after(() => {
    cli.kill("SIGTERM");
  });

  await withTimeout(
    cli.readStdoutLine(),
    5000,
    "timed out waiting for started JSONL event",
  );
  await withTimeout(
    cli.readStdoutLine(),
    5000,
    "timed out waiting for startup observation JSONL event",
  );

  cli.closeStdout();
  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);

  const exit = await withTimeout(
    cli.waitForExit(),
    5000,
    "timed out waiting for watch command to exit after output failure",
  );

  assert.equal(exit.code, 1);
  assert.equal(exit.signal, undefined);
  assert.match(cli.stderr, /watch output failed/v);
  assert.doesNotMatch(cli.stderr, /Unhandled|ERR_STREAM|EPIPE.*stack/v);

  const nextCli = spawnBuiltCli([
    "watch",
    "start",
    "--repo",
    repoPath,
    "--jsonl",
  ]);

  t.after(() => {
    nextCli.kill("SIGTERM");
  });

  await withTimeout(
    nextCli.readStdoutLine(),
    5000,
    "timed out waiting for second watch start after output failure",
  );
  await withTimeout(
    nextCli.readStdoutLine(),
    5000,
    "timed out waiting for second startup observation after output failure",
  );

  if (process.platform === "win32") {
    nextCli.kill("SIGTERM");
    await withTimeout(
      nextCli.waitForExit(),
      5000,
      "timed out waiting for second watch command to terminate on Windows",
    );
    return;
  }

  nextCli.kill("SIGTERM");
  const nextExit = await withTimeout(
    nextCli.waitForExit(),
    5000,
    "timed out waiting for second watch command to exit after SIGTERM",
  );

  assert.equal(nextExit.code, 0);
  assert.equal(nextExit.signal, undefined);
});

test(
  "watch start defaults to stderr logs with newly added Semantic Events",
  { skip: skipChildSigtermTestsOnWindows },
  async (t) => {
    const { watchedSavePath, repoPath } = await createCliHistoryRepo(t);
    const cli = spawnBuiltCli(["watch", "start", "--repo", repoPath]);
    const timestampPrefixPattern = String.raw`\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\+|-)\d{2}:\d{2}\]`;

    t.after(() => {
      cli.kill("SIGTERM");
    });

    await withTimeout(
      cli.waitForStderrIncludes("watch observation startup: committed\n"),
      5000,
      "timed out waiting for default watch startup observation log",
    );
    assert.match(
      cli.stderr,
      new RegExp(
        String.raw`${timestampPrefixPattern} watch observation startup: committed\n`,
        "v",
      ),
    );

    assert.equal(cli.stdout, "");

    await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
    await withTimeout(
      cli.waitForStderrIncludes("watch observation change: committed\n"),
      5000,
      "timed out waiting for default watch change observation log",
    );
    assert.match(
      cli.stderr,
      new RegExp(
        String.raw`${timestampPrefixPattern} watch observation change: committed\n`,
        "v",
      ),
    );
    await withTimeout(
      cli.waitForStderrIncludes("events: 1\n"),
      5000,
      "timed out waiting for default watch event count log",
    );
    await withTimeout(
      cli.waitForStderrIncludes("- Mask Shard #2: missing -> done\n"),
      5000,
      "timed out waiting for default watch Semantic Event log",
    );

    cli.kill("SIGTERM");
    const exit = await withTimeout(
      cli.waitForExit(),
      5000,
      "timed out waiting for default watch command to exit after SIGTERM",
    );

    assert.equal(exit.code, 0);
    assert.equal(exit.signal, undefined);
  },
);
