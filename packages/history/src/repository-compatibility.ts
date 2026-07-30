import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  currentRepositoryFormatVersion,
  parseProjectConfig,
  serializeProjectConfig,
} from "./config.ts";
import {
  SaveHistoryRepositoryBusyError,
  SaveHistoryRepositoryIncompatibleError,
} from "./errors.ts";
import { isUsableGitRepository, readCurrentHead } from "./git-store.ts";
import { getRepositoryLayout } from "./layout.ts";
import { isSemanticReadModelCurrent } from "./read-model.ts";
import type {
  InspectSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryResult,
  SaveHistoryRepositoryCapability,
  SaveHistoryRepositoryInspection,
  SaveHistoryRepositoryRequiredAction,
  SaveHistoryRepositoryStatus,
} from "./types.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

const inspectionTokenLifetimeMs = 5 * 60 * 1000;
const inspectionTokens = new Map<string, InspectionToken>();

interface InspectionToken {
  readonly repoPath: string;
  readonly fingerprint: string;
  readonly status: SaveHistoryRepositoryStatus;
  readonly expiresAt: number;
}

interface InspectedRepository {
  readonly inspection: SaveHistoryRepositoryInspection;
  readonly fingerprint: string;
}

export async function inspectSaveHistoryRepository(
  input: InspectSaveHistoryRepositoryInput,
): Promise<SaveHistoryRepositoryInspection> {
  const inspected = await inspectRepository(input.repoPath);
  return inspected.inspection;
}

export async function migrateSaveHistoryRepository(
  input: MigrateSaveHistoryRepositoryInput,
): Promise<MigrateSaveHistoryRepositoryResult> {
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

  const beforeLock = await inspectRepository(input.repoPath);
  if (!matchesInspectionToken(beforeLock, token)) {
    return { status: "rejected", reason: "staleInspection" };
  }

  return await migrateWithSerialization(input, token);
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
  const underLock = await inspectRepository(input.repoPath);
  if (!matchesInspectionToken(underLock, token)) {
    return { status: "rejected", reason: "staleInspection" };
  }
  if (!isMigrationStatus(underLock.inspection.status)) {
    return { status: "rejected", reason: "migrationNotRequired" };
  }

  const layout = getRepositoryLayout(input.repoPath);
  if (!(await backUpConfig(layout.configPath))) {
    return { status: "failed", reason: "backupFailed" };
  }
  const configText = await readFile(layout.configPath, "utf8");
  const parsedConfig = parseProjectConfig(configText);
  if (
    parsedConfig.status !== "legacy"
    && parsedConfig.status !== "migrationRequired"
  ) {
    return { status: "rejected", reason: "staleInspection" };
  }

  const migratedConfig = createMigratedConfig(configText);
  if (migratedConfig === undefined) {
    return { status: "failed", reason: "migrationFailed" };
  }
  if (!(await persistMigratedConfig(layout.configPath, migratedConfig))) {
    return { status: "failed", reason: "migrationFailed" };
  }

  const inspected = await inspectRepository(input.repoPath);
  const { inspection } = inspected;
  if (
    inspection.status !== "ready"
    && inspection.status !== "rebuildRequired"
  ) {
    return { status: "failed", reason: "migrationFailed" };
  }

  inspectionTokens.delete(input.inspectionId);
  return {
    status: "migrated",
    inspection,
    backupCreated: true,
  };
}

function toMigrationSerializationFailure(
  error: unknown,
): MigrateSaveHistoryRepositoryResult {
  return error instanceof SaveHistoryRepositoryBusyError
    ? { status: "failed", reason: "repositoryBusy" }
    : { status: "failed", reason: "migrationFailed" };
}

export async function assertRepositoryCapability(
  repoPath: string,
  capability: SaveHistoryRepositoryCapability,
): Promise<void> {
  const inspected = await inspectRepository(repoPath);
  const { inspection } = inspected;

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
): Promise<InspectedRepository> {
  try {
    return await inspectRepositoryCandidate(repoPath);
  } catch {
    return createInspectedRepository({
      repoPath,
      status: "invalid",
      fingerprint: createRepositoryFingerprint({ repoPath }),
    });
  }
}

async function inspectRepositoryCandidate(
  repoPath: string,
): Promise<InspectedRepository> {
  const configText = await readConfigText(repoPath);
  const config =
    configText === undefined ? undefined : parseProjectConfig(configText);
  const gitRepository = await isUsableGitRepository(repoPath);
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
  return createInspectedRepository({ repoPath, status, fingerprint });
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
}): InspectedRepository {
  pruneExpiredInspectionTokens();
  const inspectionId = createOpaqueId(24);
  const inspection = createInspection(input.status, inspectionId);
  inspectionTokens.set(inspectionId, {
    repoPath: input.repoPath,
    fingerprint: input.fingerprint,
    status: input.status,
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
): Promise<boolean> {
  try {
    await writeConfigAtomically(configPath, contents);
  } catch {
    return false;
  }

  return true;
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
