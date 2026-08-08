import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  currentRepositoryFormatVersion,
  parseProjectConfig,
  serializeProjectConfig,
} from "./config.ts";
import {
  SaveHistoryRepositoryBusyError,
  SaveHistoryRepositoryIncompatibleError,
  SaveHistoryWatcherAlreadyAcquiredError,
} from "./errors.ts";
import {
  isGitWorkTreeRepository,
  isUsableGitRepository,
  readCurrentHead,
  validateGitIntegrity,
} from "./git-store.ts";
import { getRepositoryLayout } from "./layout.ts";
import { isSemanticReadModelCurrent } from "./read-model.ts";
import type {
  ArchiveManagedRepositoryInput,
  ArchiveManagedRepositoryResult,
  ArchiveSnapshot,
  CompareWatchedSaveInput,
  GitIntegrityPolicy,
  InspectSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryResult,
  MigrationCleanupFailure,
  MigrationSourceState,
  PrepareSaveHistoryMigrationInput,
  PrepareSaveHistoryMigrationResult,
  PreparedSaveHistoryMigration,
  SaveHistoryRepositoryCapability,
  SaveHistoryRepositoryInspection,
  SaveHistoryRepositoryRequiredAction,
  SaveHistoryRepositoryStatus,
} from "./types.ts";
import {
  acquireRepositoryWatchExclusion,
  acquireWatchLock,
} from "./watch-lock.ts";
import {
  acquireHistoryWriteLease,
  withHistoryWriteLock,
} from "./write-lock.ts";

const inspectionTokenLifetimeMs = 5 * 60 * 1000;
const inspectionTokens = new Map<string, InspectionToken>();

interface InspectionToken {
  readonly repoPath: string;
  readonly fingerprint: string;
  readonly status: SaveHistoryRepositoryStatus;
  readonly gitIntegrityPolicy: GitIntegrityPolicy;
  readonly expiresAt: number;
}

interface InspectedRepository {
  readonly inspection: SaveHistoryRepositoryInspection;
  readonly fingerprint: string;
}

interface ArchiveSnapshotFileSystem {
  readonly copyRepository: (
    sourcePath: string,
    targetPath: string,
  ) => Promise<void>;
  readonly writeConfigAtomically: (
    configPath: string,
    contents: string,
  ) => Promise<void>;
}

const archiveSnapshotFileSystemState: {
  override: ArchiveSnapshotFileSystem | undefined;
} = { override: undefined };

export async function inspectSaveHistoryRepository(
  input: InspectSaveHistoryRepositoryInput,
): Promise<SaveHistoryRepositoryInspection> {
  const inspected = await inspectRepository(
    input.repoPath,
    input.gitIntegrityPolicy ?? "strict",
  );
  return inspected.inspection;
}

/**
 * Atomically moves one direct App-managed child into the App archive root. Repository format is
 * deliberately irrelevant: placement is Desktop policy, while History owns exclusion from its
 * writers and watchers for the duration of the filesystem move.
 */
export async function archiveManagedRepository(
  input: ArchiveManagedRepositoryInput,
): Promise<ArchiveManagedRepositoryResult> {
  const placement = await validateArchiveMovePlacement(input);
  if (placement === undefined) {
    return { status: "failed", reason: "invalidPlacement" };
  }

  return await archiveAtValidatedPlacement(input, placement).catch(
    archiveMoveFailure,
  );
}

async function archiveAtValidatedPlacement(
  input: ArchiveManagedRepositoryInput,
  placement: {
    readonly archivesRoot: string;
    readonly sourcePath: string;
  },
): Promise<ArchiveManagedRepositoryResult> {
  const leases = await acquireArchiveMoveLeases(placement.sourcePath);
  let destinationPath: string | undefined;

  try {
    destinationPath = await withPublicationLock(
      placement.archivesRoot,
      async () => {
        const candidate = await claimArchiveMovePath(
          placement.archivesRoot,
          input.archiveName,
        );
        return await renameToClaimedArchivePath(
          placement.sourcePath,
          candidate,
        );
      },
    );

    return {
      status: "archived",
      repoPath: destinationPath,
      name: path.basename(destinationPath),
    };
  } finally {
    await releaseArchiveMoveLeases(leases, destinationPath);
  }
}

interface ArchiveMoveLeases {
  readonly watcher?: Awaited<
    ReturnType<typeof acquireRepositoryWatchExclusion>
  >;
  readonly writer?: Awaited<ReturnType<typeof acquireHistoryWriteLease>>;
}

async function acquireArchiveMoveLeases(
  sourcePath: string,
): Promise<ArchiveMoveLeases> {
  const controlDirectory = path.join(sourcePath, ".silksong-git");
  if (!(await isRealDirectory(controlDirectory))) {
    return {};
  }
  const writer = await acquireHistoryWriteLease(sourcePath);
  try {
    const watcher = await acquireRepositoryWatchExclusion({
      repoPath: sourcePath,
    });
    return { watcher, writer };
  } catch (error) {
    await writer.release();
    throw error;
  }
}

async function releaseArchiveMoveLeases(
  leases: ArchiveMoveLeases,
  destinationPath: string | undefined,
) {
  await Promise.allSettled([
    leases.watcher?.release(),
    leases.writer?.release(),
  ]);
  if (destinationPath === undefined) {
    return;
  }
  const layout = getRepositoryLayout(destinationPath);
  await Promise.allSettled([
    rm(layout.watchLockPath, { force: true }),
    rm(layout.writeLockPath, { force: true }),
  ]);
}

function archiveMoveFailure(error: unknown): ArchiveManagedRepositoryResult {
  if (error instanceof SaveHistoryWatcherAlreadyAcquiredError) {
    return { status: "failed", reason: "watcherAlreadyAcquired" };
  }
  if (error instanceof SaveHistoryRepositoryBusyError) {
    return { status: "failed", reason: "repositoryBusy" };
  }
  return {
    status: "failed",
    reason: "moveFailed",
    message: "The repository directory could not be moved atomically.",
  };
}

async function validateArchiveMovePlacement(
  input: ArchiveManagedRepositoryInput,
): Promise<
  | {
      readonly managedRoot: string;
      readonly archivesRoot: string;
      readonly sourcePath: string;
    }
  | undefined
> {
  if (
    input.archiveName === ""
    || input.archiveName === "."
    || input.archiveName === ".."
    || path.basename(input.archiveName) !== input.archiveName
  ) {
    return undefined;
  }
  let resolved:
    | readonly [
        managedRoot: string,
        archivesRoot: string,
        sourceMetadata: Awaited<ReturnType<typeof lstat>>,
      ]
    | undefined;
  try {
    resolved = await Promise.all([
      realpath(input.managedRoot),
      realpath(input.archivesRoot),
      lstat(input.sourcePath),
    ]);
  } catch {
    return undefined;
  }
  return await validateResolvedArchivePlacement(input, resolved);
}

async function validateResolvedArchivePlacement(
  input: ArchiveManagedRepositoryInput,
  resolved: readonly [
    managedRoot: string,
    archivesRoot: string,
    sourceMetadata: Awaited<ReturnType<typeof lstat>>,
  ],
) {
  const [managedRoot, archivesRoot, sourceMetadata] = resolved;
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    return undefined;
  }
  const sourcePath = await realpath(input.sourcePath);
  if (
    path.dirname(sourcePath) !== managedRoot
    || path.dirname(input.sourcePath) !== managedRoot
    || managedRoot === archivesRoot
  ) {
    return undefined;
  }
  return { managedRoot, archivesRoot, sourcePath };
}

async function isRealDirectory(directoryPath: string): Promise<boolean> {
  const metadata = await lstat(directoryPath).catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  return metadata?.isDirectory() === true && !metadata.isSymbolicLink();
}

async function claimArchiveMovePath(
  archivesRoot: string,
  archiveName: string,
): Promise<string> {
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const name = suffix === 1 ? archiveName : `${archiveName}-${suffix}`;
    const candidate = path.join(archivesRoot, name);
    const claimed = await mkdir(candidate).then(
      () => true,
      (error: unknown) => {
        if (isExistingPathError(error)) {
          return false;
        }
        throw error;
      },
    );
    if (claimed) {
      return candidate;
    }
  }
  throw new Error("Could not find an unused archive move path.");
}

async function renameToClaimedArchivePath(
  sourcePath: string,
  claimedPath: string,
): Promise<string> {
  return await rename(sourcePath, claimedPath).then(
    () => claimedPath,
    async (error: unknown) => {
      // Remove only our still-empty claim. If anything populated it, preserve that data and the
      // original source while reporting the failed move.
      await rmdir(claimedPath).catch(() => undefined);
      throw error;
    },
  );
}

/**
 * Compares a candidate save with a repository's configured Watched Save without exposing Project
 * Config through generic repository inspection. File identity is resolved by History so Desktop
 * callers do not need to know config, Git, or SQLite details.
 */
export async function compareWatchedSave(
  input: CompareWatchedSaveInput,
): Promise<boolean> {
  const watchedSavePath = await readConfiguredWatchedSavePath(input.repoPath);
  const [configured, candidate] = await Promise.all([
    canonicalFileIdentity(watchedSavePath),
    canonicalFileIdentity(input.savePath),
  ]);
  return (
    configured.canonicalPath === candidate.canonicalPath
    || (configured.device === candidate.device
      && configured.inode === candidate.inode)
  );
}

interface CanonicalFileIdentity {
  readonly canonicalPath: string;
  readonly device: bigint | number;
  readonly inode: bigint | number;
}

async function readConfiguredWatchedSavePath(
  repoPath: string,
): Promise<string> {
  const configText = await readConfigText(repoPath);
  if (configText === undefined) {
    throw new Error("Project Config is unavailable.");
  }
  const parsed = parseProjectConfig(configText);
  switch (parsed.status) {
    case "current":
    case "legacy":
    case "migrationRequired": {
      return parsed.config.watchedSavePath;
    }

    default: {
      throw new Error(
        "Project Config is not compatible with Watched Save comparison.",
      );
    }
  }
}

async function canonicalFileIdentity(
  filePath: string,
): Promise<CanonicalFileIdentity> {
  const canonicalPath = await realpath(filePath);
  const metadata = await stat(canonicalPath, { bigint: true });
  return {
    canonicalPath,
    device: metadata.dev,
    inode: metadata.ino,
  };
}

export async function migrateSaveHistoryRepository(
  input: MigrateSaveHistoryRepositoryInput,
): Promise<MigrateSaveHistoryRepositoryResult> {
  if (input.confirmation !== "migrate-save-history-repository") {
    return createRejectedMigrationResult("confirmationRequired");
  }

  const token = inspectionTokens.get(input.inspectionId);
  if (
    token === undefined
    || token.repoPath !== input.repoPath
    || token.expiresAt < Date.now()
    || token.gitIntegrityPolicy !== "strict"
    || !isMigrationStatus(token.status)
  ) {
    return createRejectedMigrationResult("staleInspection");
  }

  const beforeLock = await inspectRepository(
    input.repoPath,
    token.gitIntegrityPolicy,
  );
  if (!matchesInspectionToken(beforeLock, token)) {
    return createRejectedMigrationResult("staleInspection");
  }

  return await migrateWithSerialization(input, token);
}

/**
 * Creates and publishes a verified archive while retaining History's write and watcher leases. The
 * returned operation is intentionally one-way: Desktop must report the snapshot before calling
 * commit, and there is no cancellation path that could leave the lease ownership ambiguous.
 */
export async function prepareSaveHistoryMigration(
  input: PrepareSaveHistoryMigrationInput,
): Promise<PrepareSaveHistoryMigrationResult> {
  if (input.confirmation !== "migrate-save-history-repository") {
    return { status: "rejected", reason: "confirmationRequired" };
  }

  const token = inspectionTokens.get(input.inspectionId);
  if (
    token === undefined
    || token.repoPath !== input.repoPath
    || token.expiresAt < Date.now()
    || !isMigrationStatus(token.status)
  ) {
    return { status: "rejected", reason: "staleInspection" };
  }

  const beforeLock = await inspectRepository(
    input.repoPath,
    token.gitIntegrityPolicy,
  );
  if (!matchesInspectionToken(beforeLock, token)) {
    return { status: "rejected", reason: "staleInspection" };
  }

  let writeLease: Awaited<ReturnType<typeof acquireHistoryWriteLease>>;
  try {
    writeLease = await acquireHistoryWriteLease(input.repoPath);
  } catch (error) {
    if (error instanceof SaveHistoryRepositoryBusyError) {
      return { status: "failed", reason: "repositoryBusy" };
    }

    return {
      status: "failed",
      reason: "snapshotFailed",
      message: "The repository could not be prepared for an archive snapshot.",
    };
  }

  const underLock = await inspectRepository(
    input.repoPath,
    token.gitIntegrityPolicy,
  );
  if (!matchesInspectionToken(underLock, token)) {
    await releaseMigrationLeases(undefined, writeLease);
    return { status: "rejected", reason: "staleInspection" };
  }
  if (!isMigrationStatus(underLock.inspection.status)) {
    await releaseMigrationLeases(undefined, writeLease);
    return { status: "rejected", reason: "migrationNotRequired" };
  }

  let watcherLease: Awaited<ReturnType<typeof acquireWatchLock>> | undefined;
  try {
    watcherLease = await acquireMigrationWatcherExclusion(input.repoPath);
    const snapshot = await createArchiveSnapshot(input);
    let completed = false;
    let leasesReleased = false;
    const operation: PreparedSaveHistoryMigration = Object.freeze({
      snapshot,
      async commit() {
        if (completed) {
          throw new Error(
            "The prepared Save History migration was already committed.",
          );
        }
        completed = true;

        let result!: MigrateSaveHistoryRepositoryResult;
        let cleanupFailure: MigrationCleanupFailure | undefined;
        try {
          result = withSnapshotState(
            await migrateUnderLock(input, token),
            snapshot,
          );
        } finally {
          cleanupFailure = await releaseLeases();
        }

        return withCleanupFailure(result, cleanupFailure);
      },
      release: async () => await releaseLeases(),
    });

    async function releaseLeases(): Promise<
      MigrationCleanupFailure | undefined
    > {
      if (leasesReleased) {
        return undefined;
      }

      leasesReleased = true;
      return await releaseMigrationLeases(watcherLease, writeLease);
    }

    return { status: "prepared", operation };
  } catch (error) {
    try {
      await releaseMigrationLeases(watcherLease, writeLease);
    } catch {
      // Preserve the primary preparation result while still attempting both releases.
    }

    if (error instanceof SaveHistoryWatcherAlreadyAcquiredError) {
      return { status: "failed", reason: "watcherAlreadyAcquired" };
    }
    if (error instanceof SnapshotDirectoryDigestMismatchError) {
      return {
        status: "failed",
        reason: "directoryDigestMismatch",
        message: error.message,
      };
    }
    if (error instanceof SaveHistoryRepositoryBusyError) {
      return { status: "failed", reason: "repositoryBusy" };
    }

    return {
      status: "failed",
      reason: "snapshotFailed",
      message: "The archive snapshot could not be verified or published.",
    };
  }
}

async function acquireMigrationWatcherExclusion(
  repoPath: string,
): Promise<Awaited<ReturnType<typeof acquireWatchLock>>> {
  const parsed = parseProjectConfig(
    await readFile(getRepositoryLayout(repoPath).configPath, "utf8"),
  );
  if (parsed.status !== "legacy" && parsed.status !== "migrationRequired") {
    throw new Error("The repository no longer requires durable migration.");
  }

  return await acquireWatchLock({
    repoPath,
    watchedSavePath: parsed.config.watchedSavePath,
    now: new Date(),
  });
}

class SnapshotDirectoryDigestMismatchError extends Error {
  override name = "SnapshotDirectoryDigestMismatchError";
}

async function createArchiveSnapshot(
  input: PrepareSaveHistoryMigrationInput,
): Promise<ArchiveSnapshot> {
  if (
    !path.isAbsolute(input.repoPath)
    || !path.isAbsolute(input.snapshotPath)
  ) {
    throw new Error("Snapshot source and destination must be absolute paths.");
  }

  const sourcePath = path.resolve(input.repoPath);
  const targetPath = path.resolve(input.snapshotPath);
  if (isPathWithin(sourcePath, targetPath)) {
    throw new Error(
      "The archive snapshot destination cannot be inside its source.",
    );
  }

  const sourceDigestBefore = await calculateDirectoryDigest(sourcePath);
  const stagingPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.staging-${createOpaqueId(12)}`,
  );
  const archiveFileSystem = getArchiveSnapshotFileSystem();

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await archiveFileSystem.copyRepository(sourcePath, stagingPath);

    const sourceDigestAfter = await calculateDirectoryDigest(sourcePath);
    const stagedDigest = await calculateDirectoryDigest(stagingPath);
    assertSnapshotDigestsMatch(
      sourceDigestBefore,
      sourceDigestAfter,
      stagedDigest,
    );

    const gitIntegrityWarning = await validateGitIntegrity(stagingPath);
    const publishedPath = await publishSnapshotNoReplace(
      stagingPath,
      targetPath,
    );

    return withGitIntegrityWarning(
      {
        repoPath: publishedPath,
        directoryDigest: stagedDigest,
      },
      gitIntegrityWarning,
    );
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

function withGitIntegrityWarning(
  snapshot: Omit<ArchiveSnapshot, "gitIntegrityWarning">,
  warning: string | undefined,
): ArchiveSnapshot {
  if (warning === undefined) {
    return snapshot;
  }

  return { ...snapshot, gitIntegrityWarning: warning };
}

async function copyDurableRepository(sourcePath: string, targetPath: string) {
  await copyDurableEntry(sourcePath, targetPath, "");
}

const nodeArchiveSnapshotFileSystem: ArchiveSnapshotFileSystem = Object.freeze({
  copyRepository: copyDurableRepository,
  writeConfigAtomically,
});

function getArchiveSnapshotFileSystem(): ArchiveSnapshotFileSystem {
  return (
    archiveSnapshotFileSystemState.override ?? nodeArchiveSnapshotFileSystem
  );
}

/**
 * Test-only fault injection. The public migration preparation Interface remains the only entry
 * point exercised by the behavior tests; this private adapter hook cannot be imported from the
 * package root or supplied by Desktop/CLI callers.
 */
export async function withArchiveSnapshotFileSystemForTests<T>(
  configure: (
    fileSystem: ArchiveSnapshotFileSystem,
  ) => ArchiveSnapshotFileSystem,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = archiveSnapshotFileSystemState.override;
  archiveSnapshotFileSystemState.override = configure(
    nodeArchiveSnapshotFileSystem,
  );
  try {
    return await operation();
  } finally {
    archiveSnapshotFileSystemState.override = previous;
  }
}

async function copyDurableEntry(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
) {
  const sourceMetadata = await lstat(sourcePath);
  if (sourceMetadata.isDirectory()) {
    await mkdir(targetPath, { recursive: true, mode: sourceMetadata.mode });
    const entries = await readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath =
        relativePath === "" ? entry.name : path.join(relativePath, entry.name);
      if (isEphemeralRepositoryPath(childRelativePath)) {
        continue;
      }

      await copyDurableEntry(
        path.join(sourcePath, entry.name),
        path.join(targetPath, entry.name),
        childRelativePath,
      );
    }
    await chmod(targetPath, sourceMetadata.mode);
    return;
  }

  if (sourceMetadata.isFile()) {
    await copyFile(sourcePath, targetPath);
    await chmod(targetPath, sourceMetadata.mode);
    return;
  }

  if (sourceMetadata.isSymbolicLink()) {
    await symlink(await readlink(sourcePath), targetPath);
    return;
  }

  throw new Error("The repository contains an unsupported filesystem entry.");
}

async function calculateDirectoryDigest(rootPath: string): Promise<string> {
  return await digestEntry(rootPath, "");
}

async function digestEntry(
  entryPath: string,
  relativePath: string,
): Promise<string> {
  const metadata = await lstat(entryPath);
  if (metadata.isDirectory()) {
    const children: string[] = [];
    const entries = await readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRelativePath =
        relativePath === "" ? entry.name : path.join(relativePath, entry.name);
      if (isEphemeralRepositoryPath(childRelativePath)) {
        continue;
      }

      const digest = await digestEntry(
        path.join(entryPath, entry.name),
        childRelativePath,
      );
      children.push(`${entry.name}\0${digest}`);
    }
    children.sort();
    return createHash("sha256")
      .update(`directory\0${relativePath}\0`)
      .update(children.join("\0"))
      .digest("hex");
  }

  if (metadata.isFile()) {
    return createHash("sha256")
      .update(`file\0${relativePath}\0`)
      .update(await readFile(entryPath))
      .digest("hex");
  }

  if (metadata.isSymbolicLink()) {
    return createHash("sha256")
      .update(`symlink\0${relativePath}\0`)
      .update(await readlink(entryPath))
      .digest("hex");
  }

  throw new Error("The repository contains an unsupported filesystem entry.");
}

function isEphemeralRepositoryPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized === ".silksong-git/read-model.sqlite") {
    return true;
  }
  if (
    normalized === ".silksong-git/write.lock"
    || normalized === ".silksong-git/watch.lock"
    || normalized === ".silksong-git/no-hooks"
    || normalized === ".silksong-git/global-attributes"
  ) {
    return true;
  }

  return normalized.startsWith(".git/") && normalized.endsWith(".lock");
}

function assertSnapshotDigestsMatch(
  sourceDigestBefore: string,
  sourceDigestAfter: string,
  stagedDigest: string,
) {
  if (
    sourceDigestBefore !== sourceDigestAfter
    || sourceDigestBefore !== stagedDigest
  ) {
    throw new SnapshotDirectoryDigestMismatchError(
      "The source changed while the archive snapshot was being copied.",
    );
  }
}

async function publishSnapshotNoReplace(
  stagingPath: string,
  targetPath: string,
): Promise<string> {
  return await withPublicationLock(path.dirname(targetPath), async () => {
    for (let collision = 0; collision < 10_000; collision++) {
      const candidate =
        collision === 0 ? targetPath : `${targetPath}-${collision}`;
      if (await pathExists(candidate)) {
        continue;
      }

      try {
        await rename(stagingPath, candidate);
        return candidate;
      } catch (error) {
        if (isExistingPathError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Could not find an unused archive snapshot path.");
  });
}

async function withPublicationLock<T>(
  parentPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockName = createHash("sha256")
    .update(path.resolve(parentPath))
    .digest("hex");
  const lockPath = path.join(
    tmpdir(),
    `silksong-history-publication-${lockName}.lock`,
  );
  const deadline = Date.now() + 3000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (!isExistingPathError(error) || Date.now() >= deadline) {
        throw new SaveHistoryRepositoryBusyError({ cause: error });
      }
      await sleep(25);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function pathExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isExistingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && "code" in error
    && ((error as NodeJS.ErrnoException).code === "EEXIST"
      || (error as NodeJS.ErrnoException).code === "ENOTEMPTY")
  );
}

async function migrateWithSerialization(
  input: MigrateSaveHistoryRepositoryInput,
  token: InspectionToken,
): Promise<MigrateSaveHistoryRepositoryResult> {
  try {
    return await withHistoryWriteLock(
      input.repoPath,
      async () => await migrateUnderLock(input, token),
    );
  } catch (error) {
    return toMigrationSerializationFailure(error);
  }
}

async function migrateUnderLock(
  input: MigrateSaveHistoryRepositoryInput,
  token: InspectionToken,
): Promise<MigrateSaveHistoryRepositoryResult> {
  const underLock = await inspectRepository(
    input.repoPath,
    token.gitIntegrityPolicy,
  );
  if (!matchesInspectionToken(underLock, token)) {
    return createRejectedMigrationResult("staleInspection");
  }
  if (!isMigrationStatus(underLock.inspection.status)) {
    return createRejectedMigrationResult("migrationNotRequired");
  }

  const layout = getRepositoryLayout(input.repoPath);
  if (!(await backUpConfig(layout.configPath))) {
    return createFailedMigrationResult("backupFailed", "unchanged");
  }
  const configText = await readFile(layout.configPath, "utf8");
  const parsedConfig = parseProjectConfig(configText);
  if (
    parsedConfig.status !== "legacy"
    && parsedConfig.status !== "migrationRequired"
  ) {
    return createRejectedMigrationResult("staleInspection");
  }

  const migratedConfig = createMigratedConfig(configText);
  if (migratedConfig === undefined) {
    return createFailedMigrationResult("migrationFailed", "unchanged");
  }
  const persisted = await persistMigratedConfig(
    layout.configPath,
    migratedConfig,
  );
  if (persisted.status === "failed") {
    return createFailedMigrationResult(
      "migrationFailed",
      persisted.sourceState,
    );
  }

  const inspected = await inspectRepository(
    input.repoPath,
    token.gitIntegrityPolicy,
  );
  const { inspection } = inspected;
  if (
    inspection.status !== "ready"
    && inspection.status !== "rebuildRequired"
  ) {
    return createFailedMigrationResult("migrationFailed", "migrated");
  }

  inspectionTokens.delete(input.inspectionId);
  return {
    status: "migrated",
    inspection,
    backupCreated: true,
    sourceState: "migrated",
    snapshotState: { status: "notCreated" },
  };
}

function toMigrationSerializationFailure(
  error: unknown,
): MigrateSaveHistoryRepositoryResult {
  return error instanceof SaveHistoryRepositoryBusyError
    ? createFailedMigrationResult("repositoryBusy", "unchanged")
    : createFailedMigrationResult("migrationFailed", "unknown");
}

function createRejectedMigrationResult(
  reason: "confirmationRequired" | "staleInspection" | "migrationNotRequired",
): MigrateSaveHistoryRepositoryResult {
  return {
    status: "rejected",
    reason,
    sourceState: "unchanged",
    snapshotState: { status: "notCreated" },
  };
}

function createFailedMigrationResult(
  reason: "backupFailed" | "repositoryBusy" | "migrationFailed",
  sourceState: MigrationSourceState,
): MigrateSaveHistoryRepositoryResult {
  return {
    status: "failed",
    reason,
    sourceState,
    snapshotState: { status: "notCreated" },
  };
}

function withSnapshotState(
  result: MigrateSaveHistoryRepositoryResult,
  snapshot: ArchiveSnapshot,
): MigrateSaveHistoryRepositoryResult {
  return {
    ...result,
    snapshotState: {
      status: "retained",
      repoPath: snapshot.repoPath,
    },
  };
}

function withCleanupFailure(
  result: MigrateSaveHistoryRepositoryResult,
  cleanupFailure: MigrationCleanupFailure | undefined,
): MigrateSaveHistoryRepositoryResult {
  if (cleanupFailure === undefined) {
    return result;
  }

  return { ...result, cleanupFailure };
}

async function releaseMigrationLeases(
  watcherLease: Awaited<ReturnType<typeof acquireWatchLock>> | undefined,
  writeLease: Awaited<ReturnType<typeof acquireHistoryWriteLease>>,
): Promise<MigrationCleanupFailure | undefined> {
  const releaseResults = await Promise.allSettled([
    watcherLease?.release() ?? Promise.resolve(),
    writeLease.release(),
  ]);
  const firstFailure = releaseResults.find(
    (result) => result.status === "rejected",
  );
  if (firstFailure?.status === "rejected") {
    return "leaseReleaseFailed";
  }

  return undefined;
}

export async function assertRepositoryCapability(
  repoPath: string,
  capability: SaveHistoryRepositoryCapability,
  access?: "readOnly",
): Promise<void> {
  const inspected = await inspectRepository(
    repoPath,
    access === "readOnly" ? "advisory" : "strict",
  );
  const { inspection } = inspected;

  if (
    access === "readOnly"
    && capability === "read"
    && isReadOnlyArchiveStatus(inspection.status)
  ) {
    return;
  }
  if (inspection.capabilities.includes(capability)) {
    return;
  }
  if (inspection.status === "ready") {
    throw new Error("Repository compatibility capabilities are inconsistent.");
  }

  throw new SaveHistoryRepositoryIncompatibleError({
    status: inspection.status,
    requiredAction: inspection.requiredAction,
    capabilities: inspection.capabilities,
  });
}

export async function withRepositoryWriteCapability<T>(
  repoPath: string,
  capability: Extract<
    SaveHistoryRepositoryCapability,
    "observe" | "restore" | "rebuildReadModel" | "watch"
  >,
  operation: () => Promise<T>,
): Promise<T> {
  await assertRepositoryCapability(repoPath, capability);

  return await withHistoryWriteLock(repoPath, async () => {
    await assertRepositoryCapability(repoPath, capability);
    return await operation();
  });
}

export async function hasExistingSaveHistoryRepository(
  repoPath: string,
): Promise<boolean> {
  const layout = getRepositoryLayout(repoPath);
  const hasGitDirectory = await hasPath(path.join(repoPath, ".git"));

  return hasGitDirectory || (await hasPath(layout.configPath));
}

async function inspectRepository(
  repoPath: string,
  gitIntegrityPolicy: GitIntegrityPolicy = "strict",
): Promise<InspectedRepository> {
  try {
    return await inspectRepositoryCandidate(repoPath, gitIntegrityPolicy);
  } catch {
    return createInspectedRepository({
      repoPath,
      status: "invalid",
      fingerprint: createRepositoryFingerprint({ repoPath }),
      gitIntegrityPolicy,
    });
  }
}

async function inspectRepositoryCandidate(
  repoPath: string,
  gitIntegrityPolicy: GitIntegrityPolicy,
): Promise<InspectedRepository> {
  const configText = await readConfigText(repoPath);
  const config =
    configText === undefined ? undefined : parseProjectConfig(configText);
  // Repository compatibility is structural. Git fsck is advisory for the Desktop archive workflow
  // and must not turn an otherwise migratable repository into an invalid candidate.
  const gitRepository =
    gitIntegrityPolicy === "strict"
      ? await isUsableGitRepository(repoPath)
      : await isGitWorkTreeRepository(repoPath);
  const headRef = gitRepository
    ? await readCurrentHeadSafely(repoPath)
    : undefined;
  const fingerprint = createRepositoryFingerprint({
    repoPath,
    configText,
    headRef,
    gitRepository,
  });

  const status = await classifyRepository({
    repoPath,
    config,
    gitRepository,
    headRef,
  });
  return createInspectedRepository({
    repoPath,
    status,
    fingerprint,
    gitIntegrityPolicy,
  });
}

async function classifyRepository(input: {
  readonly repoPath: string;
  readonly config: ReturnType<typeof parseProjectConfig> | undefined;
  readonly gitRepository: boolean;
  readonly headRef: string | undefined;
}): Promise<SaveHistoryRepositoryStatus> {
  if (
    !input.gitRepository
    || input.config === undefined
    || input.config.status === "invalid"
  ) {
    return "invalid";
  }

  switch (input.config.status) {
    case "legacy": {
      return "legacyConfig";
    }

    case "migrationRequired": {
      return "migrationRequired";
    }

    case "newerIncompatible": {
      return "newerIncompatible";
    }

    case "current": {
      return await classifyCurrentRepository(input);
    }
  }
}

async function classifyCurrentRepository(input: {
  readonly repoPath: string;
  readonly headRef: string | undefined;
}): Promise<"ready" | "rebuildRequired"> {
  return (await isSemanticReadModelCurrent(input.repoPath, input.headRef ?? ""))
    ? "ready"
    : "rebuildRequired";
}

function createInspectedRepository(input: {
  readonly repoPath: string;
  readonly status: SaveHistoryRepositoryStatus;
  readonly fingerprint: string;
  readonly gitIntegrityPolicy: GitIntegrityPolicy;
}): InspectedRepository {
  pruneExpiredInspectionTokens();
  const inspectionId = createOpaqueId(24);
  const inspection = createInspection(input.status, inspectionId);
  inspectionTokens.set(inspectionId, {
    repoPath: input.repoPath,
    fingerprint: input.fingerprint,
    status: input.status,
    gitIntegrityPolicy: input.gitIntegrityPolicy,
    expiresAt: Date.now() + inspectionTokenLifetimeMs,
  });

  return { inspection, fingerprint: input.fingerprint };
}

function createInspection(
  status: SaveHistoryRepositoryStatus,
  inspectionId: string,
): SaveHistoryRepositoryInspection {
  const details = inspectionDetails(status);
  return {
    inspectionId,
    status,
    requiredAction: details.requiredAction,
    capabilities: details.capabilities,
  } as SaveHistoryRepositoryInspection;
}

function inspectionDetails(status: SaveHistoryRepositoryStatus): {
  readonly requiredAction: SaveHistoryRepositoryRequiredAction;
  readonly capabilities: readonly SaveHistoryRepositoryCapability[];
} {
  switch (status) {
    case "ready": {
      return {
        requiredAction: "open",
        capabilities: [
          "read",
          "observe",
          "restore",
          "rebuildReadModel",
          "watch",
        ],
      };
    }

    case "rebuildRequired": {
      return {
        requiredAction: "rebuildReadModel",
        capabilities: ["rebuildReadModel"],
      };
    }

    case "legacyConfig":
    case "migrationRequired": {
      return { requiredAction: "confirmMigration", capabilities: [] };
    }

    case "newerIncompatible": {
      return { requiredAction: "useNewerApp", capabilities: [] };
    }

    case "invalid": {
      return { requiredAction: "chooseAnotherDirectory", capabilities: [] };
    }
  }
}

function matchesInspectionToken(
  inspected: InspectedRepository,
  token: InspectionToken,
): boolean {
  return (
    inspected.fingerprint === token.fingerprint
    && inspected.inspection.status === token.status
  );
}

function isMigrationStatus(status: SaveHistoryRepositoryStatus): boolean {
  return status === "legacyConfig" || status === "migrationRequired";
}

function isReadOnlyArchiveStatus(status: SaveHistoryRepositoryStatus): boolean {
  return isMigrationStatus(status);
}

async function readConfigText(repoPath: string): Promise<string | undefined> {
  try {
    return await readFile(getRepositoryLayout(repoPath).configPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function readCurrentHeadSafely(
  repoPath: string,
): Promise<string | undefined> {
  try {
    return await readCurrentHead(repoPath);
  } catch {
    return undefined;
  }
}

function createRepositoryFingerprint(input: {
  readonly repoPath: string;
  readonly configText?: string;
  readonly headRef?: string;
  readonly gitRepository?: boolean;
}): string {
  return createHash("sha256")
    .update(input.repoPath)
    .update("\0")
    .update(input.gitRepository === true ? "git" : "not-git")
    .update("\0")
    .update(input.headRef ?? "no-head")
    .update("\0")
    .update(input.configText ?? "no-config")
    .digest("hex");
}

async function backUpConfig(configPath: string): Promise<boolean> {
  try {
    await createConfigBackup(configPath);
  } catch {
    return false;
  }

  return true;
}

async function createConfigBackup(configPath: string) {
  const backupPath = path.join(
    path.dirname(configPath),
    `config.before-migration.${Date.now()}.${createOpaqueId(8)}.json`,
  );
  await copyFile(configPath, backupPath);
}

function createMigratedConfig(configText: string): string | undefined {
  let config: Record<string, unknown>;

  try {
    config = JSON.parse(configText) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  return serializeProjectConfig({
    ...config,
    repositoryFormatVersion: currentRepositoryFormatVersion,
  } as Parameters<typeof serializeProjectConfig>[0]);
}

async function persistMigratedConfig(
  configPath: string,
  contents: string,
): Promise<
  | { readonly status: "written" }
  | { readonly status: "failed"; readonly sourceState: MigrationSourceState }
> {
  const archiveFileSystem = getArchiveSnapshotFileSystem();

  try {
    await archiveFileSystem.writeConfigAtomically(configPath, contents);
  } catch {
    return {
      status: "failed",
      sourceState: await classifySourceAfterMigrationWrite(configPath),
    };
  }

  return { status: "written" };
}

async function classifySourceAfterMigrationWrite(
  configPath: string,
): Promise<MigrationSourceState> {
  let config: ReturnType<typeof parseProjectConfig>;
  try {
    config = parseProjectConfig(await readFile(configPath, "utf8"));
  } catch {
    return "unknown";
  }

  switch (config.status) {
    case "current": {
      return "migrated";
    }

    case "legacy":
    case "migrationRequired": {
      return "unchanged";
    }

    default: {
      return "unknown";
    }
  }
}

async function writeConfigAtomically(configPath: string, contents: string) {
  const temporaryPath = `${configPath}.${createOpaqueId(8)}.tmp`;
  await writeFile(temporaryPath, contents, { flag: "wx" });
  await rename(temporaryPath, configPath);
}

async function hasPath(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    return !isMissingPathError(error);
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function createOpaqueId(byteLength: number): string {
  // The workspace TypeScript lib does not yet include Uint8Array's base64 API.
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return randomBytes(byteLength).toString("base64url");
}

function pruneExpiredInspectionTokens() {
  const now = Date.now();
  for (const [inspectionId, token] of inspectionTokens) {
    if (token.expiresAt < now) {
      inspectionTokens.delete(inspectionId);
    }
  }
}
