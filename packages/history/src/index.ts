import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createProjectConfig,
  readProjectConfig,
  serializeProjectConfig,
} from "./config.ts";
import {
  InvalidRestoreBackupDirectoryError,
  RestoreBackupFailedError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
} from "./errors.ts";
import {
  readCurrentHead,
  readGitBlob,
  readHistoryCommit,
  runGit,
} from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import {
  defaultGitignoreContent,
  encodedSaveArtifactPath,
  getRepositoryLayout,
} from "./layout.ts";
import { decodeObservation } from "./observation-decoder.ts";
import type { ObservationMetadata } from "./observation.ts";
import { commitRawSaveObservation } from "./raw-observation-store.ts";
import {
  diffReadModelCommits,
  queryReadModelHistory,
  rebuildReadModel,
  searchReadModelEvents,
} from "./read-model.ts";
import type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  ObserveSaveInput,
  ObserveSaveResult,
  QueryHistoryInput,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
} from "./types.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export {
  InvalidCommitRefError,
  InvalidRestoreBackupDirectoryError,
  ReadModelUnavailableError,
  RestoreBackupFailedError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
} from "./errors.ts";

export type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  ObservationTrigger,
  ObserveSaveInput,
  ObserveSaveResult,
  ProjectConfig,
  ProjectConfigOverrides,
  QueryHistoryInput,
  RawSaveObservation,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
  RestoreTarget,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
  SemanticUpdateResult,
  WatcherError,
} from "./types.ts";

export async function initSaveHistory(
  input: InitSaveHistoryInput,
): Promise<InitSaveHistoryResult> {
  const layout = getRepositoryLayout(input.repoPath);

  await mkdir(input.repoPath, { recursive: true });
  await runGit(input.repoPath, ["init"]);

  await mkdir(layout.silksongGitDirectory, { recursive: true });
  await writeFile(layout.gitignorePath, defaultGitignoreContent);
  await writeFile(
    layout.configPath,
    serializeProjectConfig(createProjectConfig(input)),
  );

  return {
    repoPath: input.repoPath,
    configPath: layout.configPath,
  };
}

export async function observeSave(
  input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  return await withHistoryWriteLock(input.repoPath, async () => {
    const config = await readProjectConfig(input.repoPath);
    const trigger = input.trigger ?? "watcher";
    const isManualCheckpoint = trigger === "manualCheckpoint";
    const shouldCommitUnchanged =
      isManualCheckpoint && input.allowUnchanged === true;
    const observedAt = input.observedAt ?? new Date();
    const encodedBytes = await readFile(config.watchedSavePath);
    const encodedSha256 = sha256Hex(encodedBytes);
    const lastObservation = await readLastObservation(input.repoPath);

    if (
      !shouldCommitUnchanged
      && lastObservation?.encodedSha256 === encodedSha256
    ) {
      return {
        status: "skipped",
        reason: "unchanged",
        encodedSha256,
      };
    }

    if (
      !isManualCheckpoint
      && isInsideMinimumCommitInterval(
        lastObservation?.observedAt,
        observedAt,
        config.capturePolicy.minCommitIntervalMs,
      )
    ) {
      return {
        status: "skipped",
        reason: "minimumCommitInterval",
        encodedSha256,
      };
    }

    const decoded = decodeObservation(encodedBytes);

    if (decoded.status === "watcherError") {
      return decoded;
    }

    const previousCommit = await readCurrentHead(input.repoPath);
    const observationMetadata: ObservationMetadata = {
      observedAt: observedAt.toISOString(),
      trigger,
      message: input.message,
      sourcePath: config.watchedSavePath,
      encodedSha256,
      previousCommit,
      decodedSha256: decoded.decodedSha256,
      decoderVersion: decoded.decoderVersion,
      schema: decoded.schema,
    };

    return {
      status: "committed",
      observation: await commitRawSaveObservation({
        repoPath: input.repoPath,
        encodedBytes,
        decodedJson: decoded.decodedJson,
        metadata: observationMetadata,
      }),
      semanticUpdate: decoded.semanticUpdate,
    };
  });
}

export async function restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult> {
  const { target } = input;

  if (target.kind === "path") {
    return await restoreToPath({ ...input, target });
  }

  return await withHistoryWriteLock(
    input.repoPath,
    async () => await restoreInPlace({ ...input, target }),
  );
}

async function restoreToPath(
  input: RestoreEncodedSaveInput & {
    readonly target: Extract<
      RestoreEncodedSaveInput["target"],
      { kind: "path" }
    >;
  },
): Promise<RestoreEncodedSaveResult> {
  const encodedSave = await readGitBlob(
    input.repoPath,
    input.commitRef,
    encodedSaveArtifactPath,
  );

  await writeRestoreTarget(input.target, encodedSave);

  return {
    commit: await readHistoryCommit(input.repoPath, input.commitRef),
    targetPath: input.target.path,
    writtenSha256: sha256Hex(encodedSave),
  };
}

async function restoreInPlace(
  input: RestoreEncodedSaveInput & {
    readonly target: Extract<
      RestoreEncodedSaveInput["target"],
      { kind: "inPlace" }
    >;
  },
): Promise<RestoreEncodedSaveResult> {
  const config = await readProjectConfig(input.repoPath);
  const targetPath = config.watchedSavePath;
  const backupDirectory = await resolveBackupDirectory({
    configuredBackupDirectory:
      input.target.backupDirectory ?? config.restore.backupDirectory,
    watchedSavePath: targetPath,
  });
  const encodedSave = await readGitBlob(
    input.repoPath,
    input.commitRef,
    encodedSaveArtifactPath,
  );
  const writtenSha256 = sha256Hex(encodedSave);
  const backupPath = await backUpWatchedSave({
    targetPath,
    backupDirectory,
    now: input.now ?? new Date(),
  });

  await writeInPlaceRestoreTarget(targetPath, encodedSave, backupPath);
  await verifyInPlaceRestoreTarget(targetPath, writtenSha256, backupPath);

  return {
    commit: await readHistoryCommit(input.repoPath, input.commitRef),
    targetPath,
    writtenSha256,
    backupPath,
  };
}

export async function rebuildSemanticReadModel(
  input: RebuildSemanticReadModelInput,
): Promise<RebuildSemanticReadModelResult> {
  return await withHistoryWriteLock(
    input.repoPath,
    async () => await rebuildReadModel(input.repoPath),
  );
}

export async function queryHistory(
  input: QueryHistoryInput,
): Promise<HistoryResult> {
  return await Promise.resolve(queryReadModelHistory(input.repoPath, input));
}

export async function diffCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  return await diffReadModelCommits(input);
}

export async function searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  return await Promise.resolve(searchReadModelEvents(input.repoPath, input));
}

async function readLastObservation(
  repoPath: string,
): Promise<ObservationMetadata | undefined> {
  try {
    const observationJson = await readFile(
      getRepositoryLayout(repoPath).observationPath,
      "utf8",
    );

    return JSON.parse(observationJson) as ObservationMetadata;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function resolveBackupDirectory(input: {
  readonly configuredBackupDirectory: string | undefined;
  readonly watchedSavePath: string;
}): Promise<string> {
  if (input.configuredBackupDirectory === undefined) {
    return path.dirname(input.watchedSavePath);
  }

  if (!path.isAbsolute(input.configuredBackupDirectory)) {
    throw new InvalidRestoreBackupDirectoryError({
      backupDirectory: input.configuredBackupDirectory,
      reason: "backupDirectory must be an absolute path",
    });
  }

  await ensureBackupDirectory(input.configuredBackupDirectory);

  return input.configuredBackupDirectory;
}

async function ensureBackupDirectory(backupDirectory: string) {
  await createBackupDirectory(backupDirectory);
  await assertBackupDirectory(backupDirectory);
}

async function createBackupDirectory(backupDirectory: string) {
  try {
    await mkdir(backupDirectory, { recursive: true });
  } catch (error) {
    throw new InvalidRestoreBackupDirectoryError(
      {
        backupDirectory,
        reason: "backup directory cannot be created",
      },
      { cause: error },
    );
  }
}

async function assertBackupDirectory(backupDirectory: string) {
  const directoryStat = await readBackupDirectoryStat(backupDirectory);

  if (!directoryStat.isDirectory()) {
    throw new InvalidRestoreBackupDirectoryError({
      backupDirectory,
      reason: "backup path is not a directory",
    });
  }
}

async function readBackupDirectoryStat(backupDirectory: string) {
  try {
    return await stat(backupDirectory);
  } catch (error) {
    throw new InvalidRestoreBackupDirectoryError(
      {
        backupDirectory,
        reason: "backup directory cannot be read",
      },
      { cause: error },
    );
  }
}

async function backUpWatchedSave(input: {
  readonly targetPath: string;
  readonly backupDirectory: string;
  readonly now: Date;
}): Promise<string | undefined> {
  const existingBytes = await readExistingRestoreTarget({
    targetPath: input.targetPath,
    backupDirectory: input.backupDirectory,
  });

  if (existingBytes === undefined) {
    return undefined;
  }

  return await writeBackupFile({
    ...input,
    existingBytes,
  });
}

async function readExistingRestoreTarget(input: {
  readonly targetPath: string;
  readonly backupDirectory: string;
}): Promise<Buffer | undefined> {
  try {
    return await readFile(input.targetPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw new RestoreBackupFailedError(
      {
        targetPath: input.targetPath,
        backupDirectory: input.backupDirectory,
      },
      { cause: error },
    );
  }
}

async function writeBackupFile(input: {
  readonly targetPath: string;
  readonly backupDirectory: string;
  readonly now: Date;
  readonly existingBytes: Buffer;
}): Promise<string> {
  return await writeBackupPathCandidate({
    ...input,
    backupPaths: createBackupPathCandidates(input),
  });
}

async function writeBackupPathCandidate(input: {
  readonly targetPath: string;
  readonly backupDirectory: string;
  readonly existingBytes: Buffer;
  readonly backupPaths: readonly string[];
}): Promise<string> {
  const [backupPath, ...remainingBackupPaths] = input.backupPaths;

  if (backupPath === undefined) {
    throw new RestoreBackupFailedError({
      targetPath: input.targetPath,
      backupDirectory: input.backupDirectory,
    });
  }

  try {
    await writeFile(backupPath, input.existingBytes, { flag: "wx" });

    return backupPath;
  } catch (error) {
    if (isFileExistsError(error)) {
      return await writeBackupPathCandidate({
        ...input,
        backupPaths: remainingBackupPaths,
      });
    }

    throw new RestoreBackupFailedError(
      {
        targetPath: input.targetPath,
        backupDirectory: input.backupDirectory,
      },
      { cause: error },
    );
  }
}

function createBackupPathCandidates(input: {
  readonly targetPath: string;
  readonly backupDirectory: string;
  readonly now: Date;
}): readonly string[] {
  const baseName = path.basename(input.targetPath);
  const timestamp = formatBackupTimestamp(input.now);
  const stem = `${baseName}.before-restore.${timestamp}`;

  return Array.from({ length: 10 }, (_, index) => {
    const suffix = index === 0 ? "" : `.${index}`;

    return path.join(input.backupDirectory, `${stem}${suffix}.dat`);
  });
}

function formatBackupTimestamp(date: Date): string {
  const withoutDashes = date.toISOString().replaceAll("-", "");
  const withoutColons = withoutDashes.replaceAll(":", "");

  return withoutColons.replace(/\.\d{3}Z$/v, "Z");
}

async function writeInPlaceRestoreTarget(
  targetPath: string,
  encodedSave: Buffer,
  backupPath: string | undefined,
) {
  try {
    await writeFile(targetPath, encodedSave);
  } catch (error) {
    throw new RestoreWriteFailedError(
      {
        targetPath,
        backupPath,
      },
      { cause: error },
    );
  }
}

async function verifyInPlaceRestoreTarget(
  targetPath: string,
  expectedSha256: string,
  backupPath: string | undefined,
) {
  let actualSha256: string;

  try {
    actualSha256 = sha256Hex(await readFile(targetPath));
  } catch {
    actualSha256 = "unreadable";
  }

  if (actualSha256 !== expectedSha256) {
    throw new RestoreWriteVerificationError({
      targetPath,
      backupPath,
      expectedSha256,
      actualSha256,
    });
  }
}

async function writeRestoreTarget(
  target: Extract<RestoreEncodedSaveInput["target"], { readonly kind: "path" }>,
  encodedSave: Buffer,
) {
  const flag = target.overwrite === true ? "w" : "wx";

  try {
    await writeFile(target.path, encodedSave, { flag });
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new RestoreTargetExistsError(target.path, { cause: error });
    }

    throw error;
  }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isInsideMinimumCommitInterval(
  lastObservedAt: string | undefined,
  observedAt: Date,
  minCommitIntervalMs: number,
): boolean {
  if (lastObservedAt === undefined || minCommitIntervalMs <= 0) {
    return false;
  }

  return (
    observedAt.getTime() - Date.parse(lastObservedAt) < minCommitIntervalMs
  );
}
