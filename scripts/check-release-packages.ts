import { readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const publishablePackagePaths = [
  "packages/core/package.json",
  "apps/cli/package.json",
] as const;
const privatePackagePaths = [
  "packages/history/package.json",
  "packages/repo-session/package.json",
] as const;
const workspacePackagePaths = [
  ...publishablePackagePaths,
  ...privatePackagePaths,
  "apps/desktop/package.json",
  "apps/desktop-sidecar/package.json",
  "apps/web/package.json",
] as const;
const forbiddenDependencyPrefixes = ["file:", "link:", "workspace:"];

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly private?: boolean;
  readonly version?: string;
}

const publishablePackages = await Promise.all(
  publishablePackagePaths.map(readPackageManifest),
);
const versions = new Set(
  publishablePackages.map(({ manifest }) => manifest.version),
);

if (versions.size !== 1 || versions.has(undefined)) {
  throw new Error(
    `Publishable packages must share one version, found: ${[...versions].join(", ")}`,
  );
}

const [version] = versions;

if (version === undefined) {
  throw new Error("Expected a publishable package version.");
}

const expectedInternalRange = `^${version}`;
const publishablePackageNames = new Set(
  publishablePackages.map(({ manifest }) => manifest.name),
);

for (const { manifest, relativePath } of publishablePackages) {
  if (manifest.name === undefined || manifest.private === true) {
    throw new Error(`${relativePath} must describe a public named package.`);
  }
}

const privatePackages = await Promise.all(
  privatePackagePaths.map(readPackageManifest),
);

for (const { manifest, relativePath } of privatePackages) {
  if (manifest.private !== true) {
    throw new Error(`${relativePath} must remain private.`);
  }
}

const workspacePackages = await Promise.all(
  workspacePackagePaths.map(readPackageManifest),
);

for (const { manifest, relativePath } of workspacePackages) {
  for (const [dependencyName, dependencyRange] of getDependencyEntries(
    manifest,
  )) {
    if (
      forbiddenDependencyPrefixes.some((prefix) =>
        dependencyRange.startsWith(prefix),
      )
    ) {
      throw new Error(
        `${relativePath} contains forbidden dependency ${dependencyName}: ${dependencyRange}`,
      );
    }

    if (
      publishablePackageNames.has(dependencyName)
      && dependencyRange !== expectedInternalRange
    ) {
      throw new Error(
        `${relativePath} must depend on ${dependencyName} using ${expectedInternalRange}, found ${dependencyRange}`,
      );
    }
  }
}

console.log(
  `release package manifests are consistent at ${version} (${expectedInternalRange})`,
);

async function readPackageManifest(relativePath: string) {
  const packagePath = path.join(REPO_ROOT, relativePath);
  const manifest = JSON.parse(
    await readFile(packagePath, "utf8"),
  ) as PackageManifest;

  return { manifest, relativePath };
}

function getDependencyEntries(
  manifest: PackageManifest,
): ReadonlyArray<readonly [string, string]> {
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
    ...Object.entries(manifest.peerDependencies ?? {}),
  ];
}
