import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
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
  CompareWatchedSaveInput,
  CompareWatchedSaveRepositoriesInput,
  CopyRepositorySnapshotInput,
  CopyRepositorySnapshotResult,
  CopyRepositorySnapshotSourceStatus,
  GitIntegrityPolicy,
  InspectSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryResult,
  MigrationCleanupFailure,
  MigrationSourceState,
  PrepareRepositoryReplacementInput,
  PrepareSaveHistoryMigrationInput,
  PrepareSaveHistoryMigrationResult,
  PreparedRepositoryReplacement,
  PreparedSaveHistoryMigration,
  RelocateRepositoryInput,
  RelocateRepositoryResult,
  RepositoryReplacementPreparationResult,
  RepositoryReplacementResolution,
  RepositorySnapshot,
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

interface RepositorySnapshotFileSystem {
  readonly copyRepository: (
    sourcePath: string,
    targetPath: string,
  ) => Promise<void>;
  readonly writeConfigAtomically: (
    configPath: string,
    contents: string,
  ) => Promise<void>;
  readonly renameSnapshot: (
    sourcePath: string,
    targetPath: string,
  ) => Promise<void>;
}

const repositorySnapshotFileSystemState: {
  override: RepositorySnapshotFileSystem | undefined;
} = { override: undefined };

interface RepositoryLeaseReleaseFailures {
  readonly watcher: boolean;
  readonly writer: boolean;
}

const repositoryLeaseReleaseFailureState: {
  override: RepositoryLeaseReleaseFailures | undefined;
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
 * Atomically moves one real repository directory to a caller-selected destination. Repository
 * format is deliberately irrelevant: placement policy is caller-owned, while History owns exclusion
 * from its writers and watchers for the duration of the filesystem move.
 */
export async function relocateRepository(
  input: RelocateRepositoryInput,
): Promise<RelocateRepositoryResult> {
  const placement = await validateRelocationPlacement(input);
  if (placement === undefined) {
    return { status: "failed", reason: "invalidPlacement" };
  }

  return await relocateAtValidatedPlacement(placement).catch(relocationFailure);
}

async function relocateAtValidatedPlacement(placement: {
  readonly sourcePath: string;
  readonly targetPath: string;
}): Promise<RelocateRepositoryResult> {
  const leases = await acquireRelocationLeases(placement.sourcePath);
  let destinationPath: string | undefined;

  try {
    destinationPath = await withPublicationLock(
      path.dirname(placement.targetPath),
      async () => {
        const candidate = await claimRelocationPath(placement.targetPath);
        return await renameToClaimedPath(placement.sourcePath, candidate);
      },
    );

    return {
      status: "relocated",
      destinationPath,
    };
  } finally {
    await releaseRelocationLeases(
      leases,
      placement.sourcePath,
      destinationPath,
    );
  }
}

interface RelocationLeases {
  readonly watcher?: Awaited<
    ReturnType<typeof acquireRepositoryWatchExclusion>
  >;
  readonly writer?: Awaited<ReturnType<typeof acquireHistoryWriteLease>>;
}

async function acquireRelocationLeases(
  sourcePath: string,
): Promise<RelocationLeases> {
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

async function releaseRelocationLeases(
  leases: RelocationLeases,
  sourcePath: string,
  destinationPath: string | undefined,
) {
  const currentPath = destinationPath ?? sourcePath;
  await Promise.allSettled([
    leases.watcher?.releaseAt(currentPath),
    leases.writer?.releaseAt(currentPath),
  ]);
}

function relocationFailure(error: unknown): RelocateRepositoryResult {
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

async function validateRelocationPlacement(
  input: RelocateRepositoryInput,
): Promise<
  | {
      readonly sourcePath: string;
      readonly targetPath: string;
    }
  | undefined
> {
  if (
    !path.isAbsolute(input.sourcePath)
    || !path.isAbsolute(input.targetPath)
  ) {
    return undefined;
  }
  const targetParent = path.dirname(path.resolve(input.targetPath));
  if (
    path.basename(input.targetPath) === ""
    || path.basename(input.targetPath) === "."
    || path.basename(input.targetPath) === ".."
  ) {
    return undefined;
  }

  let resolved: readonly [
    sourceParent: string,
    targetParent: string,
    sourceMetadata: Awaited<ReturnType<typeof lstat>>,
  ];
  try {
    resolved = await Promise.all([
      realpath(path.dirname(input.sourcePath)),
      realpath(targetParent),
      lstat(input.sourcePath),
    ]);
  } catch {
    return undefined;
  }

  const [sourceParent, resolvedTargetParent, sourceMetadata] = resolved;
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    return undefined;
  }
  const sourcePath = await realpath(input.sourcePath);
  if (
    path.dirname(sourcePath) !== sourceParent
    || path.dirname(input.sourcePath) !== sourceParent
    || resolvedTargetParent !== targetParent
    || isPathWithin(sourcePath, resolvedTargetParent)
    || sourcePath === path.resolve(input.targetPath)
  ) {
    return undefined;
  }
  return {
    sourcePath,
    targetPath: path.join(
      resolvedTargetParent,
      path.basename(input.targetPath),
    ),
  };
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

async function claimRelocationPath(targetPath: string): Promise<string> {
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = suffix === 1 ? targetPath : `${targetPath}-${suffix}`;
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
  throw new Error("Could not find an unused relocation path.");
}

async function renameToClaimedPath(
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
 * Config through generic repository inspection. File identity is resolved by History so callers do
 * not need to know config, Git, or SQLite details.
 */
export async function compareWatchedSave(
  input: CompareWatchedSaveInput,
): Promise<boolean> {
  const watchedSavePath = await readConfiguredWatchedSavePath(input.repoPath);
  return await compareWatchedSaveIdentity(watchedSavePath, input.savePath);
}

/**
 * Compares the Watched Save identities configured by two repositories. Project Config remains an
 * internal History concern: callers receive only the comparison result, never either configured
 * path.
 */
export async function compareWatchedSaveRepositories(
  input: CompareWatchedSaveRepositoriesInput,
): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    readConfiguredWatchedSavePath(input.leftRepoPath),
    readConfiguredWatchedSavePath(input.rightRepoPath),
  ]);
  return await compareWatchedSaveIdentity(leftPath, rightPath);
}

async function compareWatchedSaveIdentity(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    canonicalFileIdentity(leftPath),
    canonicalFileIdentity(rightPath),
  ]);
  return (
    left.canonicalPath === right.canonicalPath
    || (left.device === right.device && left.inode === right.inode)
  );
}

/**
 * Copies a compatible external repository into a caller-selected destination without modifying the
 * source. This workflow deliberately does not consume an inspection token or expose migration's
 * two-phase commit operation.
 */
export async function copyRepositorySnapshot(
  input: CopyRepositorySnapshotInput,
): Promise<CopyRepositorySnapshotResult> {
  const placement = await validateCopyPlacement(input);
  if (placement === undefined) {
    return {
      status: "rejected",
      reason: "invalidPlacement",
    };
  }

  const initialInspection = await inspectRepository(
    placement.sourcePath,
    "strict",
  );
  if (initialInspection.inspection.status === "newerIncompatible") {
    return {
      status: "rejected",
      reason: "newerIncompatible",
      sourceStatus: initialInspection.inspection.status,
    };
  }
  if (!isCopySourceStatus(initialInspection.inspection.status)) {
    return {
      status: "rejected",
      reason: "invalidSource",
      sourceStatus: initialInspection.inspection.status,
    };
  }

  let writer: Awaited<ReturnType<typeof acquireHistoryWriteLease>>;

  // eslint-disable-next-line unicorn/try-complexity
  try {
    writer = withLeaseReleaseFailure(
      await acquireHistoryWriteLease(placement.sourcePath),
      repositoryLeaseReleaseFailureState.override?.writer === true,
    );
  } catch (error) {
    return copyPreparationFailure(error);
  }

  let watcher: Awaited<ReturnType<typeof acquireRepositoryWatchExclusion>>;

  // eslint-disable-next-line unicorn/try-complexity
  try {
    watcher = withLeaseReleaseFailure(
      await acquireRepositoryWatchExclusion({
        repoPath: placement.sourcePath,
      }),
      repositoryLeaseReleaseFailureState.override?.watcher === true,
    );
  } catch (error) {
    const cleanupFailure = await releaseCopyLeases(undefined, writer);
    return withCopyCleanupFailure(
      copyPreparationFailure(error),
      cleanupFailure,
    );
  }

  // The lock-held workflow intentionally combines reinspection, copy, and cleanup in one
  // transaction so a source cannot change between the status check and publication.
  let result!: CopyRepositorySnapshotResult;
  // eslint-disable-next-line unicorn/try-complexity
  try {
    const underLock = await inspectRepository(placement.sourcePath, "strict");
    if (underLock.inspection.status === "newerIncompatible") {
      result = {
        status: "rejected",
        reason: "newerIncompatible",
        sourceStatus: underLock.inspection.status,
      };
    } else if (isCopySourceStatus(underLock.inspection.status)) {
      const snapshot = await createVerifiedSnapshotUnderLocks(
        placement.sourcePath,
        placement.targetPath,
        placement.stagingRootPath,
      );
      result = {
        status: "copied",
        snapshot,
        sourceStatus: underLock.inspection.status,
      };
    } else {
      result = {
        status: "rejected",
        reason: "invalidSource",
        sourceStatus: underLock.inspection.status,
      };
    }
  } catch (error) {
    result = copyPreparationFailure(error);
  } finally {
    const cleanupFailure = await releaseCopyLeases(watcher, writer);
    result = withCopyCleanupFailure(result, cleanupFailure);
  }

  return result;
}

/**
 * Prepares the reversible repository move used by an explicit replacement workflow.
 *
 * The returned handle owns both repository leases until `resolve` or the crash-only `release`
 * finalizer is called. Once the source directory is moved, the lock files move with it; lease
 * release therefore always targets the operation's current directory instead of assuming the old
 * managed path still contains the lock files. This operation never reads, writes, creates, or
 * removes the caller's claimed replacement directory.
 */
export async function prepareRepositoryReplacement(
  input: PrepareRepositoryReplacementInput,
): Promise<RepositoryReplacementPreparationResult> {
  const placement = await validateRelocationPlacement(input);
  if (placement === undefined) {
    return { status: "rejected", reason: "invalidPlacement" };
  }

  const initialInspection = await inspectRepository(
    placement.sourcePath,
    "strict",
  );
  if (!isReplacementSourceStatus(initialInspection.inspection.status)) {
    return {
      status: "rejected",
      reason: "sourceNotEligible",
      sourceStatus: initialInspection.inspection.status,
    };
  }

  let writer: Awaited<ReturnType<typeof acquireHistoryWriteLease>>;
  try {
    writer = await acquireHistoryWriteLease(placement.sourcePath);
  } catch (error) {
    return replacementPreparationFailure(
      error,
      initialInspection.inspection.status,
    );
  }

  let watcher: Awaited<ReturnType<typeof acquireRepositoryWatchExclusion>>;
  try {
    watcher = await acquireRepositoryWatchExclusion({
      repoPath: placement.sourcePath,
    });
  } catch (error) {
    await writer.release();
    return replacementPreparationFailure(
      error,
      initialInspection.inspection.status,
    );
  }

  // Every path after acquiring these leases must release them, including publication failures.
  // eslint-disable-next-line unicorn/try-complexity
  try {
    const underLock = await inspectRepository(placement.sourcePath, "strict");
    if (!isReplacementSourceStatus(underLock.inspection.status)) {
      await releaseReplacementLeases(watcher, writer, placement.sourcePath);
      return {
        status: "rejected",
        reason: "sourceNotEligible",
        sourceStatus: underLock.inspection.status,
      };
    }

    if (
      !(await doesWatchedSaveMatch(
        placement.sourcePath,
        input.expectedWatchedSavePath,
      ))
    ) {
      await releaseReplacementLeases(watcher, writer, placement.sourcePath);
      return {
        status: "rejected",
        reason: "differentWatchedSave",
        sourceStatus: underLock.inspection.status,
      };
    }

    const destinationPath = await withPublicationLock(
      path.dirname(placement.targetPath),
      async () => {
        const candidate = await claimRelocationPath(placement.targetPath);
        return await renameToClaimedPath(placement.sourcePath, candidate);
      },
    );

    let currentPath = destinationPath;
    let terminal: RepositoryReplacementResolution | undefined;
    let leasesReleased = false;
    const operation: PreparedRepositoryReplacement = Object.freeze({
      destinationPath,
      async resolve(decision: "commit" | "rollback") {
        if (terminal !== undefined) {
          return terminal;
        }

        if (decision === "commit") {
          const cleanupWarning = await releaseReplacementLeases(
            watcher,
            writer,
            currentPath,
          );
          leasesReleased = true;
          terminal = {
            status: "committed",
            sourcePath: placement.sourcePath,
            destinationPath,
            ...(cleanupWarning !== undefined && { cleanupWarning }),
          };
          return terminal;
        }

        // Rollback must release the held leases even when the original path was repopulated.
        // eslint-disable-next-line unicorn/try-complexity
        try {
          await moveRepositoryBack(destinationPath, placement.sourcePath);
          currentPath = placement.sourcePath;
          const cleanupWarning = await releaseReplacementLeases(
            watcher,
            writer,
            currentPath,
          );
          leasesReleased = true;
          terminal = {
            status: "rolledBack",
            sourcePath: placement.sourcePath,
            destinationPath,
            ...(cleanupWarning !== undefined && { cleanupWarning }),
          };
        } catch {
          const cleanupWarning = await releaseReplacementLeases(
            watcher,
            writer,
            currentPath,
          );
          leasesReleased = true;
          terminal = {
            status: "rollbackFailed",
            sourcePath: placement.sourcePath,
            destinationPath,
            ...(cleanupWarning !== undefined && { cleanupWarning }),
            message: "The relocated repository could not be moved back safely.",
          };
        }

        return terminal;
      },
      async release() {
        if (leasesReleased) {
          return undefined;
        }
        leasesReleased = true;
        return await releaseReplacementLeases(watcher, writer, currentPath);
      },
    });

    return {
      status: "prepared",
      operation,
      sourceStatus: underLock.inspection.status,
    };
  } catch (error) {
    await releaseReplacementLeases(watcher, writer, placement.sourcePath);
    return replacementPreparationFailure(
      error,
      initialInspection.inspection.status,
    );
  }
}

function isReplacementSourceStatus(
  status: SaveHistoryRepositoryStatus,
): status is "ready" | "legacyConfig" | "migrationRequired" {
  return (
    status === "ready"
    || status === "legacyConfig"
    || status === "migrationRequired"
  );
}

async function doesWatchedSaveMatch(
  repoPath: string,
  selectedSavePath: string,
): Promise<boolean> {
  let identities:
    | readonly [CanonicalFileIdentity, CanonicalFileIdentity]
    | undefined;
  try {
    const configuredPath = await readConfiguredWatchedSavePath(repoPath);
    identities = await Promise.all([
      canonicalFileIdentity(configuredPath),
      canonicalFileIdentity(selectedSavePath),
    ]);
  } catch {
    return false;
  }
  const [configured, selected] = identities;
  return (
    configured.canonicalPath === selected.canonicalPath
    || (configured.device === selected.device
      && configured.inode === selected.inode)
  );
}

async function moveRepositoryBack(destinationPath: string, sourcePath: string) {
  if (await pathExists(sourcePath)) {
    throw new Error("The original repository path is no longer empty.");
  }
  await rename(destinationPath, sourcePath);
}

function replacementPreparationFailure(
  error: unknown,
  sourceStatus: SaveHistoryRepositoryStatus,
): RepositoryReplacementPreparationResult {
  if (error instanceof SaveHistoryWatcherAlreadyAcquiredError) {
    return {
      status: "failed",
      reason: "watcherAlreadyAcquired",
      sourceStatus,
    };
  }
  if (error instanceof SaveHistoryRepositoryBusyError) {
    return { status: "failed", reason: "repositoryBusy", sourceStatus };
  }
  return {
    status: "failed",
    reason: "moveFailed",
    sourceStatus,
    message: "The repository could not be relocated safely.",
  };
}

async function releaseReplacementLeases(
  watcher: Awaited<ReturnType<typeof acquireRepositoryWatchExclusion>>,
  writer: Awaited<ReturnType<typeof acquireHistoryWriteLease>>,
  repoPath: string,
): Promise<"leaseReleaseFailed" | undefined> {
  const results = await Promise.allSettled([
    watcher.releaseAt(repoPath),
    writer.releaseAt(repoPath),
  ]);
  return results.some((result) => result.status === "rejected")
    ? "leaseReleaseFailed"
    : undefined;
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
 * Creates and publishes a verified repository snapshot while retaining History's write and watcher
 * leases. The returned operation is intentionally one-way: the caller must report the snapshot
 * before calling commit, and there is no cancellation path that could leave the lease ownership
 * ambiguous.
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
      message:
        "The repository could not be prepared for a repository snapshot.",
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
    const snapshot = await createVerifiedSnapshotUnderLocks(
      input.repoPath,
      input.snapshotPath,
      input.stagingRootPath,
    );
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
    if (
      error instanceof SnapshotError
      && error.kind === "directoryDigestMismatch"
    ) {
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
      message: "The repository snapshot could not be verified or published.",
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

class SnapshotError extends Error {
  readonly kind: "directoryDigestMismatch" | "copyFailed" | "publishFailed";

  constructor(
    message: string,
    options: ErrorOptions | undefined,
    kind: "directoryDigestMismatch" | "copyFailed" | "publishFailed",
  ) {
    super(message, options);
    this.kind = kind;
    this.name = "SnapshotError";
  }
}

async function createVerifiedSnapshotUnderLocks(
  sourcePath: string,
  targetPath: string,
  stagingRootPath: string,
): Promise<RepositorySnapshot> {
  if (
    !path.isAbsolute(sourcePath)
    || !path.isAbsolute(targetPath)
    || !path.isAbsolute(stagingRootPath)
  ) {
    throw new SnapshotError(
      "The repository snapshot paths must be absolute.",
      undefined,
      "publishFailed",
    );
  }

  const resolvedSourcePath = path.resolve(sourcePath);
  const resolvedTargetPath = path.resolve(targetPath);
  const resolvedStagingRootPath = path.resolve(stagingRootPath);
  const targetParentPath = path.dirname(resolvedTargetPath);
  if (isPathWithin(resolvedSourcePath, resolvedTargetPath)) {
    throw new SnapshotError(
      "The repository snapshot destination cannot be inside its source.",
      undefined,
      "publishFailed",
    );
  }

  let stagingDirectory: string | undefined;
  let stagingPath: string | undefined;
  const snapshotFileSystem = getRepositorySnapshotFileSystem();

  // Cleanup must run for copy, digest, integrity, and publication failures alike.
  // eslint-disable-next-line unicorn/try-complexity
  try {
    // eslint-disable-next-line unicorn/try-complexity
    try {
      const initialTargetBoundary =
        await ensureRealCopyTargetParent(targetParentPath);
      const stagingBoundary = await requireRealSnapshotStagingRoot(
        resolvedStagingRootPath,
      );
      if (initialTargetBoundary.device !== stagingBoundary.device) {
        throw new Error(
          "The repository snapshot staging root and destination parent must be on the same filesystem.",
        );
      }

      const targetBoundaryBeforeCopy =
        await requireRealCopyTargetParent(targetParentPath);
      if (targetBoundaryBeforeCopy.device !== stagingBoundary.device) {
        throw new Error(
          "The repository snapshot staging root and destination parent must be on the same filesystem.",
        );
      }
      if (isPathWithin(resolvedSourcePath, resolvedStagingRootPath)) {
        throw new Error(
          "The repository snapshot staging root cannot be inside its source.",
        );
      }

      stagingDirectory = await mkdtemp(
        path.join(resolvedStagingRootPath, ".silksong-history-snapshot-"),
      );
      stagingPath = stagingDirectory;
    } catch (error) {
      throw new SnapshotError(
        "The repository snapshot staging root or destination parent is not stable.",
        { cause: error },
        "publishFailed",
      );
    }

    const sourceDigestBefore =
      await calculateDirectoryDigest(resolvedSourcePath);
    await requireRealCopyTargetParent(targetParentPath);
    try {
      await snapshotFileSystem.copyRepository(resolvedSourcePath, stagingPath);
    } catch {
      throw new SnapshotError(
        "The repository contents could not be copied.",
        undefined,
        "copyFailed",
      );
    }

    const sourceDigestAfter =
      await calculateDirectoryDigest(resolvedSourcePath);
    const stagedDigest = await calculateDirectoryDigest(stagingPath);
    assertSnapshotDigestsMatch(
      sourceDigestBefore,
      sourceDigestAfter,
      stagedDigest,
    );

    const gitIntegrityWarning = await validateGitIntegrity(stagingPath);
    let publishedPath: string;
    try {
      publishedPath = await publishSnapshotNoReplace(
        stagingPath,
        resolvedTargetPath,
      );
    } catch (error) {
      if (error instanceof SaveHistoryRepositoryBusyError) {
        throw error;
      }
      throw new SnapshotError(
        "The verified repository copy could not be published.",
        undefined,
        "publishFailed",
      );
    }

    return withGitIntegrityWarning(
      {
        repoPath: publishedPath,
        directoryDigest: stagedDigest,
      },
      gitIntegrityWarning,
    );
  } finally {
    if (stagingDirectory !== undefined) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
  }
}

interface CopyTargetDirectoryBoundary {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

async function inspectCopyTargetParent(
  directoryPath: string,
  allowMissing: boolean,
): Promise<CopyTargetDirectoryBoundary | undefined> {
  let currentPath = path.resolve(directoryPath);
  for (;;) {
    // eslint-disable-next-line unicorn/try-complexity
    try {
      const metadata = await lstat(currentPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        return undefined;
      }

      const canonicalPath = await realpath(currentPath);
      if (canonicalPath !== currentPath) {
        return undefined;
      }

      const identity = await stat(canonicalPath, { bigint: true });
      return {
        path: canonicalPath,
        device: identity.dev,
        inode: identity.ino,
      };
    } catch (error) {
      if (!allowMissing || !isMissingPathError(error)) {
        return undefined;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return undefined;
      }
      currentPath = parentPath;
    }
  }
}

async function ensureRealCopyTargetParent(
  directoryPath: string,
): Promise<CopyTargetDirectoryBoundary> {
  if ((await inspectCopyTargetParent(directoryPath, true)) === undefined) {
    throw new Error("The destination parent contains a symlink or junction.");
  }

  await mkdir(directoryPath, { recursive: true });
  return await requireRealCopyTargetParent(directoryPath);
}

async function requireRealCopyTargetParent(
  directoryPath: string,
): Promise<CopyTargetDirectoryBoundary> {
  const boundary = await inspectCopyTargetParent(directoryPath, false);
  if (boundary === undefined) {
    throw new Error("The destination parent is not a real directory.");
  }
  return boundary;
}

async function requireRealSnapshotStagingRoot(
  directoryPath: string,
): Promise<CopyTargetDirectoryBoundary> {
  if (!path.isAbsolute(directoryPath)) {
    throw new Error("The snapshot staging root must be absolute.");
  }

  const resolvedPath = path.resolve(directoryPath);
  const metadata = await lstat(resolvedPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The snapshot staging root must be a real directory.");
  }

  const canonicalPath = await realpath(resolvedPath);
  if (canonicalPath !== resolvedPath) {
    throw new Error("The snapshot staging root must not contain a symlink.");
  }

  const identity = await stat(canonicalPath, { bigint: true });
  return {
    path: canonicalPath,
    device: identity.dev,
    inode: identity.ino,
  };
}

async function validateCopyPlacement(
  input: CopyRepositorySnapshotInput,
): Promise<
  | {
      readonly sourcePath: string;
      readonly targetPath: string;
      readonly stagingRootPath: string;
    }
  | undefined
> {
  if (
    !path.isAbsolute(input.sourcePath)
    || !path.isAbsolute(input.targetPath)
    || !path.isAbsolute(input.stagingRootPath)
  ) {
    return undefined;
  }

  const sourceInputPath = path.resolve(input.sourcePath);
  const targetPath = path.resolve(input.targetPath);
  const stagingRootPath = path.resolve(input.stagingRootPath);
  const targetName = path.basename(targetPath);
  if (
    targetName === ""
    || targetName === "."
    || targetName === ".."
    || targetName.startsWith(".")
  ) {
    return undefined;
  }

  let sourceMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    sourceMetadata = await lstat(sourceInputPath);
  } catch {
    return undefined;
  }
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    return undefined;
  }

  const sourcePath = await realpath(sourceInputPath).catch(() => undefined);
  if (sourcePath === undefined) {
    return undefined;
  }
  const stagingBoundary = await requireRealSnapshotStagingRoot(
    stagingRootPath,
  ).catch(() => undefined);
  if (
    stagingBoundary === undefined
    || isPathWithin(sourcePath, stagingBoundary.path)
  ) {
    return undefined;
  }
  const targetParent = path.dirname(targetPath);
  if ((await inspectCopyTargetParent(targetParent, true)) === undefined) {
    return undefined;
  }
  if (isPathWithin(sourcePath, targetParent)) {
    return undefined;
  }

  return { sourcePath, targetPath, stagingRootPath: stagingBoundary.path };
}

function isCopySourceStatus(
  status: SaveHistoryRepositoryStatus,
): status is CopyRepositorySnapshotSourceStatus {
  return (
    status === "ready"
    || status === "rebuildRequired"
    || status === "legacyConfig"
    || status === "migrationRequired"
  );
}

function copyPreparationFailure(error: unknown): CopyRepositorySnapshotResult {
  if (error instanceof SaveHistoryWatcherAlreadyAcquiredError) {
    return {
      status: "failed",
      reason: "watcherAlreadyAcquired",
      sourceState: "unchanged",
    };
  }
  if (error instanceof SaveHistoryRepositoryBusyError) {
    return {
      status: "failed",
      reason: "repositoryBusy",
      sourceState: "unchanged",
    };
  }
  if (
    error instanceof SnapshotError
    && error.kind === "directoryDigestMismatch"
  ) {
    return {
      status: "failed",
      reason: "directoryDigestMismatch",
      sourceState: "unchanged",
      message: error.message,
    };
  }
  if (error instanceof SnapshotError && error.kind === "publishFailed") {
    return {
      status: "failed",
      reason: "publishFailed",
      sourceState: "unchanged",
      message: error.message,
    };
  }
  if (error instanceof SnapshotError && error.kind === "copyFailed") {
    return {
      status: "failed",
      reason: "copyFailed",
      sourceState: "unchanged",
      message: error.message,
    };
  }
  return {
    status: "failed",
    reason: "copyFailed",
    sourceState: "unchanged",
    message: "The repository copy could not be verified.",
  };
}

function withGitIntegrityWarning(
  snapshot: Omit<RepositorySnapshot, "gitIntegrityWarning">,
  warning: string | undefined,
): RepositorySnapshot {
  if (warning === undefined) {
    return snapshot;
  }

  return { ...snapshot, gitIntegrityWarning: warning };
}

async function copyDurableRepository(sourcePath: string, targetPath: string) {
  await copyDurableEntry(sourcePath, targetPath, "");
}

const nodeRepositorySnapshotFileSystem: RepositorySnapshotFileSystem =
  Object.freeze({
    copyRepository: copyDurableRepository,
    writeConfigAtomically,
    renameSnapshot: rename,
  });

function getRepositorySnapshotFileSystem(): RepositorySnapshotFileSystem {
  return (
    repositorySnapshotFileSystemState.override
    ?? nodeRepositorySnapshotFileSystem
  );
}

/**
 * Test-only fault injection. Public copy and migration Interfaces remain the only entry points
 * exercised by behavior tests; this private adapter hook cannot be imported from the package root
 * or supplied by external callers.
 */
export async function withRepositorySnapshotFileSystemForTests<T>(
  configure: (
    fileSystem: RepositorySnapshotFileSystem,
  ) => RepositorySnapshotFileSystem,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositorySnapshotFileSystemState.override;
  repositorySnapshotFileSystemState.override = configure(
    nodeRepositorySnapshotFileSystem,
  );
  try {
    return await operation();
  } finally {
    repositorySnapshotFileSystemState.override = previous;
  }
}

/** Test-only lease fault injection; callers still exercise the public copy Interface. */
export async function withRepositoryLeaseReleaseFailuresForTests<T>(
  failures: RepositoryLeaseReleaseFailures,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = repositoryLeaseReleaseFailureState.override;
  repositoryLeaseReleaseFailureState.override = failures;
  try {
    return await operation();
  } finally {
    repositoryLeaseReleaseFailureState.override = previous;
  }
}

function withLeaseReleaseFailure<
  T extends { readonly release: () => Promise<void> },
>(lease: T, shouldFail: boolean): T {
  if (!shouldFail) {
    return lease;
  }

  return {
    ...lease,
    async release() {
      await lease.release();
      throw new Error("Injected lease release failure.");
    },
  };
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
    throw new SnapshotError(
      "The source changed while the repository snapshot was being copied.",
      undefined,
      "directoryDigestMismatch",
    );
  }
}

async function publishSnapshotNoReplace(
  stagingPath: string,
  targetPath: string,
): Promise<string> {
  const parentPath = path.dirname(targetPath);
  const initialBoundary = await requireRealCopyTargetParent(parentPath);
  return await withPublicationLock(parentPath, async () => {
    const boundary = await requireRealCopyTargetParent(parentPath);
    if (
      boundary.device !== initialBoundary.device
      || boundary.inode !== initialBoundary.inode
    ) {
      throw new Error("The repository snapshot destination parent changed.");
    }
    const targetName = path.basename(targetPath);
    for (let collision = 0; collision < 10_000; collision++) {
      const candidate = path.join(
        boundary.path,
        collision === 0 ? targetName : `${targetName}-${collision}`,
      );
      if (await pathExists(candidate)) {
        continue;
      }

      try {
        await getRepositorySnapshotFileSystem().renameSnapshot(
          stagingPath,
          candidate,
        );
        return candidate;
      } catch (error) {
        if (isExistingPathError(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Could not find an unused repository snapshot path.");
  });
}

async function withPublicationLock<T>(
  parentPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const boundary = await requireRealCopyTargetParent(parentPath);
  const lockName = createHash("sha256").update(boundary.path).digest("hex");
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
  snapshot: RepositorySnapshot,
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

function withCopyCleanupFailure(
  result: CopyRepositorySnapshotResult,
  cleanupFailure: MigrationCleanupFailure | undefined,
): CopyRepositorySnapshotResult {
  if (cleanupFailure === undefined) {
    return result;
  }

  return { ...result, cleanupFailure };
}

async function releaseCopyLeases(
  watcherLease:
    | Awaited<ReturnType<typeof acquireRepositoryWatchExclusion>>
    | undefined,
  writeLease: Awaited<ReturnType<typeof acquireHistoryWriteLease>> | undefined,
): Promise<MigrationCleanupFailure | undefined> {
  const releaseResults = await Promise.allSettled([
    watcherLease?.release() ?? Promise.resolve(),
    writeLease?.release() ?? Promise.resolve(),
  ]);
  return releaseResults.some(
    (releaseResult) => releaseResult.status === "rejected",
  )
    ? "leaseReleaseFailed"
    : undefined;
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
    && isReadOnlyCompatibleStatus(inspection.status)
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
  // Repository compatibility is structural. Git fsck is advisory for a read-only inspection and
  // must not turn an otherwise migratable repository into an invalid candidate.
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

function isReadOnlyCompatibleStatus(
  status: SaveHistoryRepositoryStatus,
): boolean {
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
  const snapshotFileSystem = getRepositorySnapshotFileSystem();

  try {
    await snapshotFileSystem.writeConfigAtomically(configPath, contents);
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
