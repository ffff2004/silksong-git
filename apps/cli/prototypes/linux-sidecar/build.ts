import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const NODE_VERSION = "24.18.0";
const NODE_ARCHIVE_SHA256 =
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
const TARGET_TRIPLE = "x86_64-unknown-linux-gnu";
const PROTOTYPE_DIRECTORY = import.meta.dirname;
const CLI_DIRECTORY = path.resolve(PROTOTYPE_DIRECTORY, "../..");
const DIST_DIRECTORY = path.join(PROTOTYPE_DIRECTORY, "dist");
const CACHE_DIRECTORY = path.join(PROTOTYPE_DIRECTORY, ".cache");
const ARTIFACT_DIRECTORY = path.join(DIST_DIRECTORY, "artifact");

export interface BuiltSidecar {
  readonly artifactDirectory: string;
  readonly binaryPath: string;
  readonly gitPath: string;
  readonly targetTriple: string;
}

export async function buildLinuxSidecar(
  git: {
    readonly binaryPath: string;
    readonly sourceArchivePath: string;
  },
): Promise<BuiltSidecar> {
  assertBuildHost();
  await run("pnpm", [
    "exec",
    "tsup",
    "--config",
    "prototypes/linux-sidecar/tsup.config.ts",
  ]);

  const nodeDirectory = await preparePinnedNode();
  const nodePath = path.join(nodeDirectory, "bin/node");
  const bundlePath = path.join(
    DIST_DIRECTORY,
    "bundle/sidecar-entry.cjs",
  );
  const seaBlobPath = path.join(DIST_DIRECTORY, "sidecar.blob");
  const seaConfigPath = path.join(DIST_DIRECTORY, "sea-config.json");
  const binaryDirectory = path.join(ARTIFACT_DIRECTORY, "bin");
  const resourceBinDirectory = path.join(
    ARTIFACT_DIRECTORY,
    "resources/bin",
  );
  const noticesDirectory = path.join(ARTIFACT_DIRECTORY, "notices");
  const binaryPath = path.join(
    binaryDirectory,
    `silksong-git-sidecar-${TARGET_TRIPLE}`,
  );
  const gitPath = path.join(resourceBinDirectory, "git");

  await rm(ARTIFACT_DIRECTORY, { recursive: true, force: true });
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(resourceBinDirectory, { recursive: true });
  await mkdir(noticesDirectory, { recursive: true });
  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        output: seaBlobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        execArgvExtension: "none",
      },
      undefined,
      2,
    )}\n`,
  );
  await run(nodePath, ["--experimental-sea-config", seaConfigPath]);
  await copyFile(nodePath, binaryPath);
  await chmod(binaryPath, 0o755);
  await run(
    "pnpm",
    [
      "exec",
      "postject",
      binaryPath,
      "NODE_SEA_BLOB",
      seaBlobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { NODE_OPTIONS: "" },
  );
  await copyFile(git.binaryPath, gitPath);
  await chmod(gitPath, 0o755);
  await copyFile(
    path.join(nodeDirectory, "LICENSE"),
    path.join(noticesDirectory, "NODE-LICENSE"),
  );
  await writeFile(
    path.join(noticesDirectory, "GIT-COPYING"),
    await capture("tar", [
      "-xOf",
      git.sourceArchivePath,
      "git-2.54.0/COPYING",
    ]),
  );
  await copyFile(
    path.join(PROTOTYPE_DIRECTORY, "NOTICES.md"),
    path.join(noticesDirectory, "PROTOTYPE-NOTICES.md"),
  );

  return {
    artifactDirectory: ARTIFACT_DIRECTORY,
    binaryPath,
    gitPath,
    targetTriple: TARGET_TRIPLE,
  };
}

function assertBuildHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "This spike currently builds only x86_64-unknown-linux-gnu",
    );
  }
}

async function preparePinnedNode(): Promise<string> {
  const archiveName = `node-v${NODE_VERSION}-linux-x64.tar.xz`;
  const archivePath = path.join(CACHE_DIRECTORY, archiveName);
  const nodeDirectory = path.join(
    CACHE_DIRECTORY,
    `node-v${NODE_VERSION}-linux-x64`,
  );

  await mkdir(CACHE_DIRECTORY, { recursive: true });

  if (!(await exists(archivePath))) {
    await downloadVerifiedFile({
      url: `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`,
      cachePath: archivePath,
      sha256: NODE_ARCHIVE_SHA256,
    });
  }

  await assertSha256(archivePath, NODE_ARCHIVE_SHA256);

  if (!(await exists(path.join(nodeDirectory, "bin/node")))) {
    await run("tar", [
      "-xJf",
      archivePath,
      "--directory",
      CACHE_DIRECTORY,
    ]);
  }

  return nodeDirectory;
}

async function downloadVerifiedFile(input: {
  readonly url: string;
  readonly cachePath: string;
  readonly sha256: string;
}): Promise<string> {
  if (!(await exists(input.cachePath))) {
    const response = await fetch(input.url);

    if (!response.ok) {
      throw new Error(
        `Download failed with HTTP status ${response.status}: ${input.url}`,
      );
    }

    await writeFile(
      input.cachePath,
      Buffer.from(await response.arrayBuffer()),
    );
  }

  await assertSha256(input.cachePath, input.sha256);

  return input.cachePath;
}

async function assertSha256(filePath: string, expected: string) {
  const actual = createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");

  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`,
    );
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(
  command: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const child = spawn(command, [...args], {
    stdio: "inherit",
    cwd: CLI_DIRECTORY,
    env: { ...process.env, ...extraEnv },
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exit.code !== 0) {
    throw new Error(
      `${command} failed with ${
        exit.signal ?? `exit code ${String(exit.code)}`
      }`,
    );
  }
}

async function capture(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: CLI_DIRECTORY,
  });
  const chunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exit.code !== 0) {
    throw new Error(
      `${command} failed with ${
        exit.signal ?? `exit code ${String(exit.code)}`
      }`,
    );
  }

  return Buffer.concat(chunks);
}
