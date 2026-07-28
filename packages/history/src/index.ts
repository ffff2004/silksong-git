import { mkdir, writeFile } from "node:fs/promises";
import { createProjectConfig, serializeProjectConfig } from "./config.ts";
import { prepareManagedGitRepository, runGit } from "./git-store.ts";
import {
  defaultGitAttributesContent,
  defaultGitignoreContent,
  getRepositoryLayout,
} from "./layout.ts";
import { rebuildReadModel } from "./read-model.ts";
import type {
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
} from "./types.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export {
  diffCommits,
  observeSave,
  queryHistory,
  queryRawObservations,
  searchSemanticEvents,
} from "./history-interface.ts";
export { acquireSaveHistoryWatcher } from "./save-history-watcher.ts";
export { getSaveState, readEncodedSave } from "./save-state.ts";

export {
  InvalidCommitRefError,
  InvalidReadModelCursorError,
  InvalidRestoreBackupDirectoryError,
  ObservationNotFoundError,
  ReadModelUnavailableError,
  RestoreBackupFailedError,
  RestoreConflictError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
  SaveHistoryWatcherAlreadyAcquiredError,
} from "./errors.ts";

export { restoreEncodedSave } from "./restore.ts";
export type {
  AcquireSaveHistoryWatcherInput,
  DiffCommitsInput,
  DiffCommitsResult,
  GetSaveStateInput,
  GetSaveStateResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  ObservationTrigger,
  ObserveSaveHistoryWatcherInput,
  ObserveSaveInput,
  ObserveSaveResult,
  ProjectConfig,
  ProjectConfigOverrides,
  QueryHistoryInput,
  QueryRawObservationsInput,
  RawObservationHistoryEntry,
  RawObservationHistoryResult,
  RawSaveObservation,
  ReadEncodedSaveInput,
  ReadEncodedSaveResult,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
  RestoreEncodedSaveInput,
  RestoreEncodedSaveResult,
  RestoreTarget,
  SaveHistoryWatcher,
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
  await prepareManagedGitRepository(input.repoPath);

  await mkdir(layout.silksongGitDirectory, { recursive: true });
  await writeFile(layout.gitignorePath, defaultGitignoreContent);
  await writeFile(layout.gitAttributesPath, defaultGitAttributesContent);
  await writeFile(
    layout.configPath,
    serializeProjectConfig(createProjectConfig(input)),
  );

  return {
    repoPath: input.repoPath,
    configPath: layout.configPath,
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
