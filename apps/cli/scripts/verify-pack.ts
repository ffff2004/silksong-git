import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

const tempDirectory = await mkdtemp(path.join(tmpdir(), "silksong-cli-pack-"));

try {
  const packDirectory = path.join(tempDirectory, "pack");

  await mkdir(packDirectory);
  await packWorkspacePackages(packDirectory);
  const packedArchives = {
    cli: await findPackedArchive(packDirectory, "silksong-git-cli-"),
    core: await findPackedArchive(packDirectory, "silksong-git-core-"),
  };
  const localPackages = {
    "@silksong-git/cli": `file:${packedArchives.cli}`,
    "@silksong-git/core": `file:${packedArchives.core}`,
  };
  const packedCliManifest = await readPackedManifest(packedArchives.cli);

  await Promise.all(
    Object.values(packedArchives).map(async (archivePath) => {
      await verifyPackedManifestDependencies(archivePath);
    }),
  );
  await Promise.all([
    verifyPackedFiles(packedArchives.core, [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "package.json",
    ]),
    verifyPackedFiles(packedArchives.cli, [
      "LICENSE",
      "README.md",
      "dist/main.js",
      "package.json",
    ]),
  ]);

  await installAndVerifyWithPackageManager({
    expectedVersion: packedCliManifest.version,
    localPackages,
    manager: "npm",
  });
  const installedPnpmCliPath = await installAndVerifyWithPackageManager({
    expectedVersion: packedCliManifest.version,
    localPackages,
    manager: "pnpm",
  });
  const historyRepo = path.join(tempDirectory, "history-repo");
  const fixtureSave = path.join(
    REPO_ROOT,
    "packages/core/src/decode/fixtures/minimal-valid-save.dat",
  );

  await run(installedPnpmCliPath, [
    "repo",
    "init",
    "--save",
    fixtureSave,
    "--repo",
    historyRepo,
  ]);
  await verifyPackedHttpRuntime({
    cliPath: installedPnpmCliPath,
    historyRepo,
  });
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

async function installAndVerifyWithPackageManager(input: {
  readonly expectedVersion?: string;
  readonly localPackages: Readonly<Record<string, string>>;
  readonly manager: "npm" | "pnpm";
}): Promise<string> {
  if (input.expectedVersion === undefined) {
    throw new Error("Packed CLI manifest has no version.");
  }

  const installDirectory = path.join(tempDirectory, `${input.manager}-install`);

  await mkdir(installDirectory);
  await writeFile(
    path.join(installDirectory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: input.localPackages,
      },
      undefined,
      2,
    )}\n`,
  );

  if (input.manager === "pnpm") {
    await writeFile(
      path.join(installDirectory, "pnpm-workspace.yaml"),
      [
        "packages: []",
        "overrides:",
        ...Object.entries(input.localPackages).map(
          ([packageName, archive]) =>
            `  ${JSON.stringify(packageName)}: ${JSON.stringify(archive)}`,
        ),
        "",
      ].join("\n"),
    );
    await run("pnpm", [
      "--dir",
      installDirectory,
      "install",
      "--ignore-scripts",
    ]);
  } else {
    await run(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
      installDirectory,
    );
  }

  const installedCliPath = path.join(
    installDirectory,
    "node_modules/@silksong-git/cli/dist/main.js",
  );

  await verifyInstalledCliExecutable(installedCliPath);
  await run(installedCliPath, ["--help"], installDirectory);
  await run(installedCliPath, ["--version"], installDirectory, {
    expectedStdout: `${input.expectedVersion}\n`,
  });

  return installedCliPath;
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
    await callPackedWatcher(child);
  } finally {
    child.kill("SIGTERM");
    await waitForChild(child);
  }
}

async function packWorkspacePackages(packDirectory: string) {
  for (const packageName of ["@silksong-git/core", "@silksong-git/cli"]) {
    await run("pnpm", [
      "--filter",
      packageName,
      "--config.ignore-scripts=true",
      "pack",
      "--pack-destination",
      packDirectory,
    ]);
  }
}

async function verifyInstalledCliExecutable(cliPath: string) {
  await access(cliPath, constants.X_OK);
  const contents = await readFile(cliPath, "utf8");
  const firstLine = contents.split("\n", 1)[0];

  if (firstLine !== "#!/usr/bin/env node") {
    throw new Error(`Installed CLI has invalid shebang: ${firstLine}`);
  }
}

interface PackedManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly version?: string;
}

async function readPackedManifest(
  archivePath: string,
): Promise<PackedManifest> {
  const child = spawn("tar", ["-xOf", archivePath, "package/package.json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exit.code !== 0) {
    throw new Error(
      `Could not read packed manifest from ${archivePath}: ${formatExitStatus(exit)}`,
    );
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as PackedManifest;
}

async function verifyPackedManifestDependencies(archivePath: string) {
  const manifest = await readPackedManifest(archivePath);
  const dependencyRanges = [
    ...Object.values(manifest.dependencies ?? {}),
    ...Object.values(manifest.devDependencies ?? {}),
    ...Object.values(manifest.optionalDependencies ?? {}),
    ...Object.values(manifest.peerDependencies ?? {}),
  ];
  const localRange = dependencyRanges.find((range) =>
    /^(?:file|link|workspace):/v.test(range),
  );

  if (localRange !== undefined) {
    throw new Error(
      `Packed manifest ${archivePath} contains local dependency range ${localRange}`,
    );
  }
}

async function verifyPackedFiles(
  archivePath: string,
  expectedFiles: readonly string[],
) {
  const output = await runAndCapture("tar", ["-tzf", archivePath]);
  const actualFiles = output
    .split("\n")
    .map((entry) => entry.replace(/^package\//v, ""))
    .filter((entry) => entry !== "" && !entry.endsWith("/"))
    .toSorted();
  const expected = [...expectedFiles].toSorted();

  if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) {
    throw new Error(
      `Packed files for ${archivePath} differ:\nexpected ${expected.join(", ")}\nactual ${actualFiles.join(", ")}`,
    );
  }
}

async function callPackedWatcher(child: ReturnType<typeof spawn>) {
  const started = JSON.parse(await readLine(child)) as {
    readonly http?: {
      readonly endpoint?: unknown;
      readonly token?: unknown;
    };
  };
  const endpoint = String(started.http?.endpoint);
  const token = String(started.http?.token);
  const response = await fetch(`${endpoint}/api/v1/watcher`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.status !== 200) {
    throw new Error(`Packed HTTP watcher returned ${response.status}`);
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

async function findPackedArchive(
  packDirectory: string,
  prefix: string,
): Promise<string> {
  const entries = await readdir(packDirectory);
  const archives = entries.filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith(".tgz"),
  );

  if (archives.length !== 1) {
    throw new Error(
      `Expected one packed archive with prefix ${prefix}, found ${archives.length}`,
    );
  }

  const [archive] = archives;

  if (archive === undefined) {
    throw new Error(`Expected one packed archive with prefix ${prefix}`);
  }

  return path.join(packDirectory, archive);
}

async function runAndCapture(
  command: string,
  args: readonly string[],
  cwd = REPO_ROOT,
): Promise<string> {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  const exit = await waitForExit(child);

  if (exit.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${formatExitStatus(exit)}: ${Buffer.concat(stderr).toString("utf8")}`,
    );
  }

  return Buffer.concat(stdout).toString("utf8");
}

async function run(
  command: string,
  args: readonly string[],
  cwd = REPO_ROOT,
  options: { readonly expectedStdout?: string } = {},
) {
  const child = spawn(command, [...args], {
    stdio:
      options.expectedStdout === undefined
        ? "inherit"
        : ["ignore", "pipe", "inherit"],
    cwd,
  });
  const stdout: Buffer[] = [];

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  const exit = await waitForExit(child);

  if (exit.code === 0) {
    const actualStdout = Buffer.concat(stdout).toString("utf8");

    if (
      options.expectedStdout !== undefined
      && actualStdout !== options.expectedStdout
    ) {
      throw new Error(
        `${command} ${args.join(" ")} wrote ${JSON.stringify(actualStdout)}, expected ${JSON.stringify(options.expectedStdout)}`,
      );
    }

    return;
  }

  throw new Error(
    `${command} ${args.join(" ")} failed with ${formatExitStatus(exit)}`,
  );
}

async function waitForExit(child: ReturnType<typeof spawn>) {
  return await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
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
