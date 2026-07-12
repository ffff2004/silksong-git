import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const tempDirectory = await mkdtemp(path.join(tmpdir(), "silksong-cli-pack-"));

try {
  const packDirectory = path.join(tempDirectory, "pack");
  const installDirectory = path.join(tempDirectory, "install");

  await mkdir(packDirectory);
  await mkdir(installDirectory);
  await run("pnpm", [
    "--filter",
    "@silksong-git/cli",
    "pack",
    "--pack-destination",
    packDirectory,
  ]);
  await run("pnpm", [
    "--dir",
    installDirectory,
    "add",
    await findPackedArchive(packDirectory),
  ]);
  await run("pnpm", ["--dir", installDirectory, "exec", "ssgit", "--help"]);
  const historyRepo = path.join(tempDirectory, "history-repo");
  const fixtureSave = path.join(
    REPO_ROOT,
    "packages/core/src/decode/fixtures/minimal-valid-save.dat",
  );

  await run("pnpm", [
    "--dir",
    installDirectory,
    "exec",
    "ssgit",
    "repo",
    "init",
    "--save",
    fixtureSave,
    "--repo",
    historyRepo,
  ]);
  await verifyPackedHttpRuntime({
    cliPath: path.join(installDirectory, "node_modules/.bin/ssgit"),
    historyRepo,
  });
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

async function verifyPackedHttpRuntime(input: {
  readonly cliPath: string;
  readonly historyRepo: string;
}) {
  const child = spawn(
    input.cliPath,
    ["watch", "start", "--repo", input.historyRepo, "--http", "--jsonl"],
    { stdio: ["ignore", "pipe", "inherit"], cwd: REPO_ROOT },
  );

  try {
    await callPackedMeta(child);
  } finally {
    child.kill("SIGTERM");
    await waitForChild(child);
  }
}

async function callPackedMeta(child: ReturnType<typeof spawn>) {
  const started = JSON.parse(await readLine(child)) as {
    readonly http?: {
      readonly endpoint?: unknown;
      readonly token?: unknown;
    };
  };
  const endpoint = String(started.http?.endpoint);
  const token = String(started.http?.token);
  const response = await fetch(`${endpoint}/api/v1/meta`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status !== 200) {
    throw new Error(`Packed HTTP meta returned ${response.status}`);
  }
}

async function readLine(child: ReturnType<typeof spawn>): Promise<string> {
  const { stdout } = child;

  if (stdout === null) {
    throw new Error("Packed CLI stdout is unavailable");
  }

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";

    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");

      if (newline !== -1) {
        resolve(buffer.slice(0, newline));
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      reject(
        new Error(
          `Packed CLI exited before startup: ${signal ?? `code ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}

async function waitForChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

async function findPackedArchive(packDirectory: string): Promise<string> {
  const entries = await readdir(packDirectory);
  const archives = entries.filter((entry) => entry.endsWith(".tgz"));

  if (archives.length !== 1) {
    throw new Error(`Expected one packed archive, found ${archives.length}`);
  }

  const [archive] = archives;

  if (archive === undefined) {
    throw new Error("Expected one packed archive");
  }

  return path.join(packDirectory, archive);
}

async function run(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: "inherit",
    cwd: REPO_ROOT,
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exit.code === 0) {
    return;
  }

  throw new Error(
    `${command} ${args.join(" ")} failed with ${formatExitStatus(exit)}`,
  );
}

function formatExitStatus(exit: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}): string {
  if (exit.signal !== null) {
    return `signal ${exit.signal}`;
  }

  return `exit code ${exit.code ?? "unknown"}`;
}
