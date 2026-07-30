import { readProjectConfig } from "./config.ts";
import { observeSaveUsingConfig } from "./observe-save.ts";
import {
  diffReadModelCommits,
  queryReadModelHistory,
  queryReadModelRawObservations,
  searchReadModelEvents,
} from "./read-model.ts";
import {
  assertRepositoryCapability,
  withRepositoryWriteCapability,
} from "./repository-compatibility.ts";
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

export async function observeSave(
  input: ObserveSaveInput,
): Promise<ObserveSaveResult> {
  return await withRepositoryWriteCapability(
    input.repoPath,
    "observe",
    async () => {
      const config = await readProjectConfig(input.repoPath);

      return await observeSaveUsingConfig({ ...input, config });
    },
  );
}

export async function queryHistory(
  input: QueryHistoryInput,
): Promise<HistoryResult> {
  await assertRepositoryCapability(input.repoPath, "read");
  return await queryReadModelHistory(input.repoPath, input);
}

export async function queryRawObservations(
  input: QueryRawObservationsInput,
): Promise<RawObservationHistoryResult> {
  await assertRepositoryCapability(input.repoPath, "read");
  return await queryReadModelRawObservations(input.repoPath, input);
}

export async function diffCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  await assertRepositoryCapability(input.repoPath, "read");
  return await diffReadModelCommits(input);
}

export async function searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  await assertRepositoryCapability(input.repoPath, "read");
  return await searchReadModelEvents(input.repoPath, input);
}
