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
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
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
