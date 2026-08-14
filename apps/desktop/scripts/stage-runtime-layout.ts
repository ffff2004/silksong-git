import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const desktopDirectory = path.resolve(import.meta.dirname, "..");
const source = path.join(desktopDirectory, "../desktop-sidecar/dist/main.js");
const profile = process.argv[2];

if (profile !== "debug" && profile !== "release") {
  throw new Error("Usage: stage-runtime-layout.ts <debug|release>");
}

// Tauri's Linux resource resolver returns the Cargo executable directory for development and
// no-bundle builds. Keep this staging root identical to the resource root consumed by
// TauriResourceRuntimeLayoutAdapter; `build/` is not a runtime resource location.
const resourceRoot = path.join(desktopDirectory, "src-tauri/target", profile);
const runtimeDirectory = path.join(resourceRoot, "runtime");

// Remove output from the superseded development-only staging location. Git ignores it, but leaving
// a copied JavaScript sidecar there would make the repository-wide linter treat it as source code.
await rm(path.join(desktopDirectory, "build", "runtime"), {
  force: true,
  recursive: true,
});

await rm(path.join(runtimeDirectory, "sidecar"), {
  force: true,
  recursive: true,
});
await mkdir(path.join(runtimeDirectory, "sidecar"), { recursive: true });
await cp(source, path.join(runtimeDirectory, "sidecar/main.js"));
await writeFile(
  path.join(runtimeDirectory, "manifest.json"),
  `${JSON.stringify({
    layoutVersion: 1,
    layout: { type: "system" },
    sidecar: { type: "nodeEntry", path: ["sidecar", "main.js"] },
  })}\n`,
);

console.log(`Staged Desktop Runtime Layout at ${runtimeDirectory}.`);
