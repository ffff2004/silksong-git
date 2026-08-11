import { readFile } from "node:fs/promises";
import path from "node:path";
import semverSatisfies from "semver/functions/satisfies.js";
import semverValid from "semver/functions/valid.js";
import semverValidRange from "semver/ranges/valid.js";

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
  readonly bugs?: { readonly url?: string };
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly engines?: { readonly node?: string };
  readonly files?: readonly string[];
  readonly homepage?: string;
  readonly license?: string;
  readonly name?: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly private?: boolean;
  readonly publishConfig?: {
    readonly access?: string;
    readonly registry?: string;
  };
  readonly repository?: {
    readonly directory?: string;
    readonly type?: string;
    readonly url?: string;
  };
  readonly version?: string;
}

const publishablePackages = await Promise.all(
  publishablePackagePaths.map(readPackageManifest),
);
const publishablePackageNames = new Set(
  publishablePackages.map(({ manifest }) => manifest.name),
);
const publishablePackageVersions = new Map(
  publishablePackages.map(({ manifest }) => [manifest.name, manifest.version]),
);

for (const { manifest, relativePath } of publishablePackages) {
  if (manifest.name === undefined || manifest.private === true) {
    throw new Error(`${relativePath} must describe a public named package.`);
  }

  if (
    manifest.version === undefined
    || semverValid(manifest.version) === null
  ) {
    throw new Error(`${relativePath} must have a valid semver version.`);
  }

  const packageDirectory = path.posix.dirname(relativePath);

  assertEqual(manifest.license, "MIT", `${relativePath} license`);
  assertEqual(manifest.engines?.node, ">=24", `${relativePath} Node engine`);
  assertEqual(
    manifest.publishConfig?.access,
    "public",
    `${relativePath} publish access`,
  );
  assertEqual(
    manifest.publishConfig?.registry,
    "https://registry.npmjs.org/",
    `${relativePath} publish registry`,
  );
  assertEqual(
    manifest.repository?.type,
    "git",
    `${relativePath} repository type`,
  );
  assertEqual(
    manifest.repository?.url,
    "git+https://github.com/ffff2004/silksong-git.git",
    `${relativePath} repository URL`,
  );
  assertEqual(
    manifest.repository?.directory,
    packageDirectory,
    `${relativePath} repository directory`,
  );
  assertEqual(
    manifest.homepage,
    `https://github.com/ffff2004/silksong-git/tree/main/${packageDirectory}#readme`,
    `${relativePath} homepage`,
  );
  assertEqual(
    manifest.bugs?.url,
    "https://github.com/ffff2004/silksong-git/issues",
    `${relativePath} bugs URL`,
  );

  if (
    manifest.description === undefined
    || manifest.description.trim() === ""
  ) {
    throw new Error(`${relativePath} must have a description.`);
  }

  if (manifest.files?.length !== 1 || manifest.files[0] !== "dist") {
    throw new Error(`${relativePath} must publish only its dist directory.`);
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

    if (!publishablePackageNames.has(dependencyName)) {
      continue;
    }

    const dependencyVersion = publishablePackageVersions.get(dependencyName);

    if (
      dependencyVersion === undefined
      || semverValidRange(dependencyRange) === null
      || !semverSatisfies(dependencyVersion, dependencyRange)
    ) {
      throw new Error(
        `${relativePath} dependency ${dependencyName}@${dependencyRange} must accept the current ${dependencyName}@${dependencyVersion ?? "unknown"}`,
      );
    }
  }
}

const cliPackage = publishablePackages.find(
  ({ manifest }) => manifest.name === "@silksong-git/cli",
);
const cliInternalRuntimeDependencies = Object.keys(
  cliPackage?.manifest.dependencies ?? {},
).filter((dependencyName) => dependencyName.startsWith("@silksong-git/"));

if (
  cliInternalRuntimeDependencies.length !== 1
  || cliInternalRuntimeDependencies[0] !== "@silksong-git/core"
) {
  throw new Error(
    `CLI must have Core as its only internal runtime dependency, found: ${cliInternalRuntimeDependencies.join(", ")}`,
  );
}

console.log(
  `release package manifests are valid: ${publishablePackages
    .map(({ manifest }) => `${manifest.name}@${manifest.version}`)
    .join(", ")}`,
);

function assertEqual(actual: unknown, expected: unknown, description: string) {
  if (actual !== expected) {
    throw new Error(
      `${description} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`,
    );
  }
}

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
