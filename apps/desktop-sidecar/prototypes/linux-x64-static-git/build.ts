import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { PreparedStaticGit } from "./prepare-static-git.ts";
import { STATIC_GIT_VERSION } from "./prepare-static-git.ts";

const nodeVersion = "24.18.0";
const nodeArchiveSha256 =
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
const targetTriple = "x86_64-unknown-linux-gnu";
const prototypeDirectory = import.meta.dirname;
const repositoryRoot = path.resolve(prototypeDirectory, "../../../..");
const distributionDirectory = path.join(prototypeDirectory, "dist");
const cacheDirectory = path.join(prototypeDirectory, ".cache");
const artifactDirectory = path.join(distributionDirectory, "artifact");
const runtimeDirectory = path.join(artifactDirectory, "runtime");
const binaryDirectory = path.join(runtimeDirectory, "bin");
const noticesDirectory = path.join(runtimeDirectory, "notices");
const nodeArchiveName = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeArchivePath = path.join(cacheDirectory, nodeArchiveName);
const nodeUrl = `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`;
const nodeDirectory = path.join(
  cacheDirectory,
  `node-v${nodeVersion}-linux-x64`,
);
const nodePath = path.join(nodeDirectory, "bin/node");
const sidecarFileName = `silksong-git-sidecar-${targetTriple}`;
const binaryPath = path.join(binaryDirectory, sidecarFileName);
const gitPath = path.join(binaryDirectory, "git");
const bundlePath = path.join(distributionDirectory, "bundle/sidecar-entry.cjs");
const seaBlobPath = path.join(distributionDirectory, "sidecar.blob");
const seaConfigPath = path.join(distributionDirectory, "sea-config.json");

export interface BuiltSidecar {
  readonly artifactDirectory: string;
  readonly binaryPath: string;
  readonly gitPath: string;
  readonly manifestPath: string;
  readonly targetTriple: string;
}

export async function buildLinuxSidecar(
  staticGit: PreparedStaticGit,
): Promise<BuiltSidecar> {
  assertBuildHost();
  await run("pnpm", [
    "--filter",
    "@silksong-git/desktop-sidecar",
    "exec",
    "tsup",
    "--config",
    "prototypes/linux-x64-static-git/tsup.config.ts",
  ]);

  await preparePinnedNode();
  await stat(bundlePath);
  await rm(artifactDirectory, { force: true, recursive: true });
  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(noticesDirectory, { recursive: true });

  await writeFile(
    seaConfigPath,
    `${JSON.stringify(
      {
        main: bundlePath,
        mainFormat: "commonjs",
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

  await copyFile(staticGit.binaryPath, gitPath);
  await chmod(gitPath, 0o755);
  await copyFile(
    path.join(nodeDirectory, "LICENSE"),
    path.join(noticesDirectory, "NODE-LICENSE"),
  );
  await copyFile(
    staticGit.licensePath,
    path.join(noticesDirectory, "STATIC-GIT-LICENSE"),
  );
  await writeFile(
    path.join(noticesDirectory, "GIT-COPYING"),
    await capture("tar", [
      "--extract",
      "--xz",
      "--file",
      staticGit.sourceArchivePath,
      "--to-stdout",
      `git-${STATIC_GIT_VERSION}/COPYING`,
    ]),
  );
  await copyFile(
    path.join(prototypeDirectory, "NOTICES.md"),
    path.join(noticesDirectory, "PROTOTYPE-NOTICES.md"),
  );

  const manifestPath = path.join(runtimeDirectory, "manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        layoutVersion: 1,
        layout: { type: "bundled" },
        sidecar: { type: "embeddedExecutable", path: ["bin", sidecarFileName] },
        git: { path: ["bin", "git"] },
      },
      undefined,
      2,
    )}\n`,
  );

  return {
    artifactDirectory,
    binaryPath,
    gitPath,
    manifestPath,
    targetTriple,
  };
}

function assertBuildHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("This prototype builds only x86_64-unknown-linux-gnu.");
  }
}

async function preparePinnedNode() {
  await mkdir(cacheDirectory, { recursive: true });
  if (!(await exists(nodeArchivePath))) {
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--silent",
      "--show-error",
      "--output",
      nodeArchivePath,
      nodeUrl,
    ]);
  }
  await assertSha256(nodeArchivePath, nodeArchiveSha256);
  if (!(await exists(nodePath))) {
    await run("tar", [
      "--extract",
      "--xz",
      "--file",
      nodeArchivePath,
      "--directory",
      cacheDirectory,
      "--no-same-owner",
    ]);
  }
  await stat(nodePath);
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
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(
  command: string,
  args: readonly string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  const child = spawn(command, [...args], {
    stdio: "inherit",
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
  });
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${command} failed with ${result.signal ?? `exit ${String(result.code)}`}`,
    );
  }
}

async function capture(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "inherit"],
    cwd: repositoryRoot,
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${command} failed with ${result.signal ?? `exit ${String(result.code)}`}`,
    );
  }
  return Buffer.concat(chunks);
}
