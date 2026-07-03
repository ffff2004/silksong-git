import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createProjectConfig,
  readProjectConfig,
  serializeProjectConfig,
} from "./config.ts";
import { readCurrentHead, runGit } from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { defaultGitignoreContent, getRepositoryLayout } from "./layout.ts";
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

export { restoreEncodedSave } from "./restore.ts";
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
        nextAllowedAt: getNextAllowedObservationAt(
          lastObservation?.observedAt,
          config.capturePolicy.minCommitIntervalMs,
        ),
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

function getNextAllowedObservationAt(
  lastObservedAt: string | undefined,
  minCommitIntervalMs: number,
): string {
  if (lastObservedAt === undefined) {
    throw new Error("missing last observation for minimum interval skip");
  }

  const nextAllowedAt = new Date(
    Date.parse(lastObservedAt) + minCommitIntervalMs,
  );

  return nextAllowedAt.toISOString();
}
