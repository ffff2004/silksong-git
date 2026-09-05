import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const STATIC_GIT_VERSION = "2.55.0";
const STATIC_GIT_ASSET_SHA256 =
  "8c34e40809b9ec271db4b344953f73c9c3a2c3de022be308d567adeee6eb770e";
const STATIC_GIT_SOURCE_SHA256 =
  "457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357";
const STATIC_GIT_LICENSE_SHA256 =
  "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";

const prototypeDirectory = import.meta.dirname;
const repositoryRoot = path.resolve(prototypeDirectory, "../../../..");
const cacheDirectory = path.join(prototypeDirectory, ".cache");
const staticGitArchiveName = "git-binaries.linux-64bit.tar.gz";
const staticGitArchivePath = path.join(cacheDirectory, staticGitArchiveName);
const staticGitUrl = `https://github.com/darkvertex/static-git/releases/download/${STATIC_GIT_VERSION}/${staticGitArchiveName}`;
const staticGitLicensePath = path.join(cacheDirectory, "static-git-LICENSE");
const staticGitLicenseUrl = `https://raw.githubusercontent.com/darkvertex/static-git/${STATIC_GIT_VERSION}/LICENSE`;
const sourceArchiveName = `git-${STATIC_GIT_VERSION}.tar.xz`;
const sourceArchivePath = path.join(cacheDirectory, sourceArchiveName);
const sourceUrl = `https://www.kernel.org/pub/software/scm/git/${sourceArchiveName}`;
const extractedDirectory = path.join(
  cacheDirectory,
  `static-git-${STATIC_GIT_VERSION}`,
);
const binaryPath = path.join(extractedDirectory, "git");

export interface PreparedStaticGit {
  readonly binaryPath: string;
  readonly sourceArchivePath: string;
  readonly licensePath: string;
}

export async function prepareStaticGit(): Promise<PreparedStaticGit> {
  assertBuildHost();
  await mkdir(cacheDirectory, { recursive: true });
  await downloadVerifiedFile({
    url: staticGitUrl,
    cachePath: staticGitArchivePath,
    sha256: STATIC_GIT_ASSET_SHA256,
  });
  await downloadVerifiedFile({
    url: sourceUrl,
    cachePath: sourceArchivePath,
    sha256: STATIC_GIT_SOURCE_SHA256,
  });
  await downloadVerifiedFile({
    url: staticGitLicenseUrl,
    cachePath: staticGitLicensePath,
    sha256: STATIC_GIT_LICENSE_SHA256,
  });

  if (!(await exists(binaryPath))) {
    await mkdir(extractedDirectory, { recursive: true });
    await run("tar", [
      "--extract",
      "--gzip",
      "--file",
      staticGitArchivePath,
      "--directory",
      extractedDirectory,
      "--no-same-owner",
      "git",
    ]);
  }

  const binaryMetadata = await stat(binaryPath);
  if (!binaryMetadata.isFile()) {
    throw new Error("static-git archive did not contain a regular git file");
  }

  return {
    binaryPath,
    licensePath: staticGitLicensePath,
    sourceArchivePath,
  };
}

function assertBuildHost() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("This prototype builds only x86_64-unknown-linux-gnu.");
  }
}

async function downloadVerifiedFile(input: {
  readonly url: string;
  readonly cachePath: string;
  readonly sha256: string;
}) {
  if (!(await exists(input.cachePath))) {
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "3",
      "--silent",
      "--show-error",
      "--output",
      input.cachePath,
      input.url,
    ]);
  }

  await assertSha256(input.cachePath, input.sha256);
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

async function run(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: "inherit",
    cwd: repositoryRoot,
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
