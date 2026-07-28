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
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const prototypeDirectory = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(prototypeDirectory, "../..");
const bundleSource = path.join(
  prototypeDirectory,
  "src-tauri/target/release/bundle/appimage",
  "Silksong Git Tauri Linux Prototype_0.0.0_amd64.AppImage",
);
const distDirectory = path.join(prototypeDirectory, "dist");
const installedDirectory = path.join(
  distDirectory,
  "已安装 App 路径",
  "应用 包",
);
const installedBundle = path.join(
  installedDirectory,
  "Silksong Git 原型.AppImage",
);
const evidenceDirectory = path.join(distDirectory, "evidence");
const extractionDirectory = path.join(distDirectory, "appimage-extraction");
const imageName = "silksong-git-tauri-prototype-clean:issue-42";

await run(
  "pnpm",
  ["--filter", "@silksong-git/tauri-linux-prototype", "build"],
  repositoryRoot,
);
await rm(distDirectory, { recursive: true, force: true });
await mkdir(installedDirectory, { recursive: true });
await mkdir(evidenceDirectory, { recursive: true });
await copyFile(bundleSource, installedBundle);
await chmod(installedBundle, 0o755);
await mkdir(extractionDirectory, { recursive: true });
await run(installedBundle, ["--appimage-extract"], extractionDirectory, false);

await run(
  "podman",
  [
    "build",
    "--network",
    "host",
    "--tag",
    imageName,
    "--file",
    path.join(prototypeDirectory, "Containerfile.clean"),
    prototypeDirectory,
  ],
  repositoryRoot,
);
await run(
  "podman",
  [
    "run",
    "--rm",
    "--userns",
    "keep-id",
    "--network",
    "none",
    "--volume",
    `${installedDirectory}:/bundle path/应用 包:ro`,
    "--volume",
    `${evidenceDirectory}:/evidence`,
    "--tmpfs",
    "/workspace root:rw,size=256m,mode=1777",
    "--volume",
    `${path.join(prototypeDirectory, "scripts")}:/verify:ro`,
    imageName,
  ],
  repositoryRoot,
);

const tracer = JSON.parse(
  await readFile(path.join(evidenceDirectory, "clean-tracer.json"), "utf8"),
) as Record<string, unknown>;
const closeDrain = JSON.parse(
  await readFile(
    path.join(evidenceDirectory, "clean-close-drain.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const bundleStats = await stat(installedBundle);
const extractedAppImageRoot = path.join(
  extractionDirectory,
  "squashfs-root",
);
const inventory = await collectInventory(extractedAppImageRoot);
const summary = {
  verifiedAt: new Date().toISOString(),
  targetTriple: "x86_64-unknown-linux-gnu",
  realBundle: {
    format: "AppImage",
    pathWithSpacesAndUnicode: installedBundle,
    bytes: bundleStats.size,
    sha256: createHash("sha256")
      .update(await readFile(installedBundle))
      .digest("hex"),
  },
  controlledEnvironment: {
    containerImage: imageName,
    network: "none",
    systemNode: "absent",
    systemGit: "absent",
    display: "Xvfb",
  },
  tracer,
  closeDrain,
  bundleInventorySource: {
    kind: "extractedAppImage",
    root: extractedAppImageRoot,
    bundleSha256: createHash("sha256")
      .update(await readFile(installedBundle))
      .digest("hex"),
  },
  bundleInventory: inventory,
};
await writeFile(
  path.join(evidenceDirectory, "summary.json"),
  `${JSON.stringify(summary, undefined, 2)}\n`,
);
console.log(JSON.stringify(summary, undefined, 2));

async function collectInventory(root: string) {
  const output = await capture(
    "find",
    [
      root,
      "-type",
      "f",
      "-printf",
      "%P\\t%s\\n",
    ],
    repositoryRoot,
  );
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((line) =>
      /silksong-git-sidecar|private-git|notices|minimal-valid-save|usr\/bin\/silksong-git-tauri/.test(
        line,
      ),
    );
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  showStdout = true,
) {
  const child = spawn(command, [...args], {
    cwd,
    stdio: showStdout ? "inherit" : ["ignore", "ignore", "inherit"],
  });
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} failed with ${result.signal ?? `exit ${String(result.code)}`}`,
    );
  }
}

async function capture(command: string, args: readonly string[], cwd: string) {
  const child = spawn(command, [...args], {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} failed with ${result.signal ?? `exit ${String(result.code)}`}`,
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}
