import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildLinuxSidecar } from "../../cli/prototypes/linux-sidecar/build.ts";
import { prepareStaticGit } from "../../cli/prototypes/linux-sidecar/prepare-git.ts";

const targetTriple = "x86_64-unknown-linux-gnu";
const prototypeDirectory = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(prototypeDirectory, "../..");
const sourceArtifact = path.join(
  repositoryRoot,
  "apps/cli/prototypes/linux-sidecar/dist/artifact",
);
const tauriDirectory = path.join(prototypeDirectory, "src-tauri");

await rebuildIssue22Artifact();
await rm(path.join(tauriDirectory, "binaries"), {
  recursive: true,
  force: true,
});
await rm(path.join(tauriDirectory, "resources"), {
  recursive: true,
  force: true,
});
await mkdir(path.join(tauriDirectory, "binaries"), { recursive: true });
await mkdir(path.join(tauriDirectory, "resources/private-git/bin"), {
  recursive: true,
});
await mkdir(path.join(tauriDirectory, "resources/notices"), {
  recursive: true,
});
await mkdir(path.join(tauriDirectory, "resources/fixtures"), {
  recursive: true,
});
await copyFile(
  path.join(
    sourceArtifact,
    `bin/silksong-git-sidecar-${targetTriple}`,
  ),
  path.join(
    tauriDirectory,
    `binaries/silksong-git-sidecar-${targetTriple}`,
  ),
);
await chmod(
  path.join(
    tauriDirectory,
    `binaries/silksong-git-sidecar-${targetTriple}`,
  ),
  0o755,
);
await copyFile(
  path.join(sourceArtifact, "resources/bin/git"),
  path.join(tauriDirectory, "resources/private-git/bin/git"),
);
await chmod(
  path.join(tauriDirectory, "resources/private-git/bin/git"),
  0o755,
);
await cp(
  path.join(sourceArtifact, "notices"),
  path.join(tauriDirectory, "resources/notices"),
  { recursive: true },
);
await copyFile(
  path.join(
    repositoryRoot,
    "packages/core/src/decode/fixtures/minimal-valid-save.dat",
  ),
  path.join(tauriDirectory, "resources/fixtures/minimal-valid-save.dat"),
);
await prepareIcons();

console.log(
  `Prepared issue #22 artifact as Tauri externalBin/resources (${targetTriple}).`,
);

async function rebuildIssue22Artifact() {
  const git = await prepareStaticGit();
  await buildLinuxSidecar(git);
  await access(
    path.join(
      sourceArtifact,
      `bin/silksong-git-sidecar-${targetTriple}`,
    ),
  );
  await access(path.join(sourceArtifact, "resources/bin/git"));
}

async function prepareIcons() {
  const iconDirectory = path.join(tauriDirectory, "icons");
  await mkdir(iconDirectory, { recursive: true });
  const source = path.join(iconDirectory, "icon.png");
  await run(
    "magick",
    [
      "-size",
      "512x512",
      "xc:#17151d",
      "-fill",
      "#efb34c",
      "-draw",
      "circle 256,256 256,76",
      "-fill",
      "#17151d",
      "-draw",
      "roundrectangle 145,145 367,215 28,28",
      "-draw",
      "roundrectangle 145,297 367,367 28,28",
      source,
    ],
    repositoryRoot,
  );
  await run("magick", [source, "-resize", "128x128", path.join(iconDirectory, "128x128.png")], repositoryRoot);
  await run("magick", [source, "-resize", "32x32", path.join(iconDirectory, "32x32.png")], repositoryRoot);
}

async function run(command: string, args: readonly string[], cwd: string) {
  const child = spawn(command, [...args], {
    cwd,
    stdio: "inherit",
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
