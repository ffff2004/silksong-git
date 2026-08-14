import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const profile = process.argv[2];

if (profile !== "debug" && profile !== "release") {
  throw new Error("Usage: verify-runtime-stage.ts <debug|release>");
}

// This is the same root that Tauri resolves for a Cargo executable at src-tauri/target/<profile>/
// on Linux. The Rust startup adapter reads only resourceRoot/runtime/manifest.json, in development
// and after no-bundle builds alike.
const resourceRoot = path.join(desktopDirectory, "src-tauri/target", profile);
const runtimeRoot = path.join(resourceRoot, "runtime");
const manifestPath = path.join(runtimeRoot, "manifest.json");
const sidecarPath = path.join(runtimeRoot, "sidecar", "main.js");
const configPath = path.join(desktopDirectory, "src-tauri", "tauri.conf.json");
const cargoManifestPath = path.join(
  desktopDirectory,
  "src-tauri",
  "Cargo.toml",
);
const packagePath = path.join(desktopDirectory, "package.json");

const manifestText = await readFile(manifestPath, "utf8");
const manifest: unknown = JSON.parse(manifestText);
if (
  JSON.stringify(manifest)
  !== JSON.stringify({
    layoutVersion: 1,
    layout: { type: "system" },
    sidecar: { type: "nodeEntry", path: ["sidecar", "main.js"] },
  })
) {
  throw new Error("Staged Runtime Layout has an unexpected manifest.");
}

const sidecarMetadata = await stat(sidecarPath);
if (!sidecarMetadata.isFile()) {
  throw new Error("Staged Runtime Layout is missing its copied sidecar entry.");
}

const cargoManifest = await readFile(cargoManifestPath, "utf8");
if (!/^default\s*=\s*\["runtime-system"\]$/mv.test(cargoManifest)) {
  throw new Error(
    "This unqualified staging producer supports Tauri's default runtime-system build only.",
  );
}

const config = JSON.parse(await readFile(configPath, "utf8")) as {
  bundle?: { resources?: Record<string, string> };
  build?: { beforeBuildCommand?: string; beforeDevCommand?: string };
};
if (config.bundle?.resources !== undefined) {
  throw new Error(
    "Unqualified runtime staging must not configure a separate bundle resource root.",
  );
}
const beforeDevCommand = config.build?.beforeDevCommand;
const beforeBuildCommand = config.build?.beforeBuildCommand;
if (
  typeof beforeDevCommand !== "string"
  || !beforeDevCommand.includes("pnpm stage:runtime:dev")
  || typeof beforeBuildCommand !== "string"
  || !beforeBuildCommand.includes("pnpm stage:runtime:build")
) {
  throw new Error(
    "Tauri lifecycle hooks must stage the matching resource root.",
  );
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
  scripts?: Record<string, string>;
};
const { scripts } = packageJson;
if (
  scripts === undefined
  || scripts["stage:runtime:dev"]
    !== "tsx scripts/stage-runtime-layout.ts debug"
  || scripts["stage:runtime:build"]
    !== "tsx scripts/stage-runtime-layout.ts release"
) {
  throw new Error(
    "Runtime staging must select Tauri's debug and release resource roots.",
  );
}

const ignored = spawnSync("git", ["check-ignore", "-q", resourceRoot], {
  cwd: desktopDirectory,
});
if (ignored.status !== 0) {
  throw new Error("Tauri runtime resource output must be Git-ignored.");
}

console.log(
  `Desktop Runtime Layout staging exists at Tauri's ${profile} resource root.`,
);
