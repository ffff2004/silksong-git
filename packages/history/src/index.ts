import { mkdir, writeFile } from "node:fs/promises";
import { createProjectConfig, serializeProjectConfig } from "./config.ts";
import { SaveHistoryRepositoryIncompatibleError } from "./errors.ts";
import { prepareManagedGitRepository, runGit } from "./git-store.ts";
import {
  defaultGitAttributesContent,
  defaultGitignoreContent,
  getRepositoryLayout,
} from "./layout.ts";
import { rebuildReadModel } from "./read-model.ts";
import {
  hasExistingSaveHistoryRepository,
  inspectSaveHistoryRepository,
  withRepositoryWriteCapability,
} from "./repository-compatibility.ts";
import type {
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  RebuildSemanticReadModelInput,
  RebuildSemanticReadModelResult,
} from "./types.ts";

export {
  diffCommits,
  observeSave,
  queryHistory,
  queryRawObservations,
  searchSemanticEvents,
} from "./history-interface.ts";
export {
  inspectSaveHistoryRepository,
  migrateSaveHistoryRepository,
} from "./repository-compatibility.ts";
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
  SaveHistoryRepositoryIncompatibleError,
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
  InspectSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryInput,
  MigrateSaveHistoryRepositoryResult,
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
  SaveHistoryRepositoryCapability,
  SaveHistoryRepositoryInspection,
  SaveHistoryRepositoryRequiredAction,
  SaveHistoryRepositoryStatus,
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

  if (await hasExistingSaveHistoryRepository(input.repoPath)) {
    const inspection = await inspectSaveHistoryRepository({
      repoPath: input.repoPath,
    });
    if (inspection.status !== "ready") {
      throw new SaveHistoryRepositoryIncompatibleError({
        status: inspection.status,
        requiredAction: inspection.requiredAction,
        capabilities: inspection.capabilities,
      });
    }

    throw new Error("A Save History Repository already exists at this path.");
  }

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
  await rebuildReadModel(input.repoPath);

  return {
    repoPath: input.repoPath,
    configPath: layout.configPath,
  };
}

export async function rebuildSemanticReadModel(
  input: RebuildSemanticReadModelInput,
): Promise<RebuildSemanticReadModelResult> {
  return await withRepositoryWriteCapability(
    input.repoPath,
    "rebuildReadModel",
    async () => await rebuildReadModel(input.repoPath),
  );
}
