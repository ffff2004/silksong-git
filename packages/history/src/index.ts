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
export { createLocalHttpApp } from "./http-app.ts";
export type { LocalHttpApp } from "./http-app.ts";
export { createLocalHttpOpenApiDocument } from "./http-contract.ts";
export { getSaveState, readEncodedSave } from "./save-state.ts";

export {
  InvalidCommitRefError,
  InvalidReadModelCursorError,
  InvalidRestoreBackupDirectoryError,
  LocalHistoryWatchProcessAlreadyRunningError,
  LocalHttpServerStartError,
  ObservationNotFoundError,
  ReadModelUnavailableError,
  RestoreBackupFailedError,
  RestoreConflictError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
} from "./errors.ts";

export { startLocalHistoryWatchProcess } from "./local-history-watch-process.ts";
export { restoreEncodedSave } from "./restore.ts";
export type {
  DiffCommitsInput,
  DiffCommitsResult,
  FileStabilityProbe,
  GetSaveStateInput,
  GetSaveStateResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  LocalHistoryWatcherStatus,
  LocalHistoryWatchProcess,
  LocalHistoryWatchProcessEvent,
  LocalHistoryWatchProcessFatalError,
  ObservationTrigger,
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
  ScheduledWatchTask,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
  SemanticUpdateResult,
  StartLocalHistoryWatchProcessInput,
  WatcherError,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
  WatchScheduler,
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
