import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import {
  diffReadModelCommits,
  queryReadModelHistory,
  queryReadModelRawObservations,
  searchReadModelEvents,
} from "./read-model.ts";
import type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoryResult,
  ObserveSaveInput,
  ObserveSaveResult,
  QueryHistoryInput,
  QueryRawObservationsInput,
  RawObservationHistoryResult,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
} from "./types.ts";
import { withHistoryWriteLock } from "./write-lock.ts";

export async function observeSave(
  input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  return await withHistoryWriteLock(input.repoPath, async () => {
    const config = await readProjectConfig(input.repoPath);

    return await observeSaveUsingConfig({ ...input, config });
  });
}

export async function queryHistory(
  input: QueryHistoryInput,
): Promise<HistoryResult> {
  return await queryReadModelHistory(input.repoPath, input);
}

export async function queryRawObservations(
  input: QueryRawObservationsInput,
): Promise<RawObservationHistoryResult> {
  return await queryReadModelRawObservations(input.repoPath, input);
}

export async function diffCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  return await diffReadModelCommits(input);
}

export async function searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  return await searchReadModelEvents(input.repoPath, input);
}
