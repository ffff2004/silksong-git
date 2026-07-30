import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readProjectConfig } from "./config.ts";
import {
  InvalidRestoreBackupDirectoryError,
  RestoreBackupFailedError,
  RestoreConflictError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
} from "./errors.ts";
import { readGitBlob, readHistoryCommit } from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { encodedSaveArtifactPath } from "./layout.ts";
import { withRepositoryWriteCapability } from "./repository-compatibility.ts";
import type {
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
} from "./types.ts";

export async function restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult> {
  return await withRepositoryWriteCapability(
    input.repoPath,
    "restore",
    async () => {
      const { target } = input;

      if (target.kind === "path") {
        return await restoreToPath({ ...input, target });
      }

      return await restoreInPlace({ ...input, target });
    },
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
  await assertExpectedCurrentSave(targetPath, input.target.expectedCurrent);
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

async function assertExpectedCurrentSave(
  targetPath: string,
  expected:
    | { readonly status: "present"; readonly encodedSha256: string }
    | { readonly status: "missing" }
    | undefined,
) {
  if (expected === undefined) {
    return;
  }

  let bytes: Buffer | undefined;

  try {
    bytes = await readFile(targetPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const matches =
    expected.status === "missing"
      ? bytes === undefined
      : bytes !== undefined && sha256Hex(bytes) === expected.encodedSha256;

  if (!matches) {
    throw new RestoreConflictError();
  }
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
