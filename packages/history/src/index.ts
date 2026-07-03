import { mkdir, writeFile } from "node:fs/promises";
import {
  createProjectConfig,
  readProjectConfig,
  serializeProjectConfig,
} from "./config.ts";
import { runGit } from "./git-store.ts";
import { defaultGitignoreContent, getRepositoryLayout } from "./layout.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
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
  LocalHistoryApiProcessAlreadyRunningError,
  ReadModelUnavailableError,
  RestoreBackupFailedError,
  RestoreTargetExistsError,
  RestoreWriteFailedError,
  RestoreWriteVerificationError,
  SaveHistoryRepositoryBusyError,
} from "./errors.ts";

export { startLocalHistoryApiProcess } from "./local-history-api-process.ts";
export { restoreEncodedSave } from "./restore.ts";
export type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InitSaveHistoryInput,
  InitSaveHistoryResult,
  LocalHistoryApiProcess,
  LocalHistoryApiProcessEvent,
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
  StartLocalHistoryApiProcessInput,
  WatcherError,
  WatchEventSource,
  WatchEventSourceStartInput,
  WatchEventSubscription,
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

    return await observeSaveUsingConfig({ ...input, config });
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
