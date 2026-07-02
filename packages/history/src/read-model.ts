import {
  createSemanticSnapshot,
  diffSemanticSnapshots,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { DatabaseSync } from "node:sqlite";

import { readProjectConfig } from "./config.ts";
import { ReadModelUnavailableError } from "./errors.ts";
import {
  readGitBlob,
  readHistoryCommit,
  readObservationCommitRefs,
} from "./git-store.ts";
import { getRepositoryLayout } from "./layout.ts";
import type { ObservationMetadata } from "./observation.ts";
import {
  applyDisplayFilters,
  getEventVisibility,
} from "./read-model/event-visibility.ts";
import type { QueryEventsOptions } from "./read-model/queries.ts";
import {
  selectEventRows,
  selectObservation,
  selectRawObservations,
  selectSearchEventRows,
  selectSnapshot,
  toHistoricalSemanticEvent,
} from "./read-model/queries.ts";
import { readModelSchemaVersion, resetSchema } from "./read-model/schema.ts";
import type { RecognizedSnapshotRecord } from "./read-model/types.ts";
import {
  insertEvents,
  insertMetadata,
  insertObservation,
  insertSnapshot,
} from "./read-model/writes.ts";
import type {
  DiffCommitsInput,
  DiffCommitsResult,
  HistoryResult,
  RawSaveObservation,
  RebuildSemanticReadModelResult,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
} from "./types.ts";

interface GitObservationRecord {
  readonly commitRef: string;
  readonly observation: RawSaveObservation;
  readonly decodedSave: unknown;
}

export async function rebuildReadModel(
  repoPath: string,
): Promise<RebuildSemanticReadModelResult> {
  using db = openReadModel(repoPath);

  const mappingData = getBuiltinMappingData();
  const commits = await readObservationCommitRefs(repoPath);
  const gitObservations = await Promise.all(
    commits.map(
      async (commitRef): Promise<GitObservationRecord> => ({
        commitRef,
        observation: await readRawSaveObservation(repoPath, commitRef),
        decodedSave: JSON.parse(
          await readGitTextBlob(repoPath, commitRef, "decoded-save.json"),
        ) as unknown,
      }),
    ),
  );

  resetSchema(db);

  const recognizedSnapshots: RecognizedSnapshotRecord[] = [];
  let unrecognizedObservationCount = 0;

  for (const [index, gitObservation] of gitObservations.entries()) {
    const sequence = index + 1;

    insertObservation(db, sequence, gitObservation.observation);

    if (gitObservation.observation.schema.status === "unrecognized") {
      unrecognizedObservationCount++;
      continue;
    }

    const snapshot = createSemanticSnapshot(
      parseDecodedSave(gitObservation.decodedSave),
      mappingData,
    );
    const snapshotId = `snapshot:${gitObservation.observation.commit.ref}`;

    insertSnapshot(db, {
      commitRef: gitObservation.observation.commit.ref,
      observationSequence: sequence,
      snapshotId,
      snapshot,
    });
    recognizedSnapshots.push({
      commitRef: gitObservation.observation.commit.ref,
      observationSequence: sequence,
      snapshotId,
      snapshot,
    });
  }

  const eventCount = insertEvents(db, recognizedSnapshots);

  insertMetadata(db, "schemaVersion", readModelSchemaVersion);
  insertMetadata(db, "sourceHeadRef", commits.at(-1) ?? "");

  return {
    observationCount: commits.length,
    recognizedObservationCount: recognizedSnapshots.length,
    unrecognizedObservationCount,
    snapshotCount: recognizedSnapshots.length,
    eventCount,
  };
}

export async function queryReadModelHistory(
  repoPath: string,
  options: QueryEventsOptions = {},
): Promise<HistoryResult> {
  return await withReadModelAvailability(
    async () => await queryAvailableReadModelHistory(repoPath, options),
  );
}

export async function diffReadModelCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  return await withReadModelAvailability(
    async () => await diffAvailableReadModelCommits(input),
  );
}

export async function searchReadModelEvents(
  repoPath: string,
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  return await withReadModelAvailability(
    async () => await searchAvailableReadModelEvents(repoPath, input),
  );
}

async function queryAvailableReadModelHistory(
  repoPath: string,
  options: QueryEventsOptions,
): Promise<HistoryResult> {
  const config = await readProjectConfig(repoPath);
  const filters = config.displaySemanticEventFilters;
  using db = openReadModel(repoPath);
  const page = selectEventRows(db, options);
  const events = applyDisplayFilters(
    page.rows.map((row) => toHistoricalSemanticEvent(row, filters)),
    options.includeFiltered,
  );
  const rawObservations =
    options.includeRawObservations === true
      ? selectRawObservations(db)
      : undefined;

  return {
    events,
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    ...(rawObservations !== undefined && { rawObservations }),
  };
}

async function diffAvailableReadModelCommits(
  input: DiffCommitsInput,
): Promise<DiffCommitsResult> {
  const [config, from, to] = await Promise.all([
    readProjectConfig(input.repoPath),
    readHistoryCommit(input.repoPath, input.fromRef),
    readHistoryCommit(input.repoPath, input.toRef),
  ]);
  const filters = config.displaySemanticEventFilters;
  using db = openReadModel(input.repoPath);
  const before = selectSnapshot(db, from.ref);
  const after = selectSnapshot(db, to.ref);
  const observation = selectObservation(db, to.ref);
  const events = applyDisplayFilters(
    diffSemanticSnapshots(before, after).map((event, index) => ({
      id: `${to.ref}:${index}`,
      commit: to,
      previousCommit: from,
      observation,
      event,
      visibility: getEventVisibility(event, filters),
    })),
    input.includeFiltered,
  );

  return {
    from,
    to,
    before,
    after,
    events,
  };
}

async function searchAvailableReadModelEvents(
  repoPath: string,
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult> {
  const config = await readProjectConfig(repoPath);
  const filters = config.displaySemanticEventFilters;
  using db = openReadModel(repoPath);

  return {
    events: applyDisplayFilters(
      selectSearchEventRows(db, input.query).map((row) =>
        toHistoricalSemanticEvent(row, filters),
      ),
      input.includeFiltered,
    ),
  };
}

async function withReadModelAvailability<T>(
  readModelOperation: () => Promise<T>,
): Promise<T> {
  try {
    return await readModelOperation();
  } catch (error) {
    throwReadModelUnavailableError(error);
  }
}

async function readRawSaveObservation(
  repoPath: string,
  commitRef: string,
): Promise<RawSaveObservation> {
  const metadata = JSON.parse(
    await readGitTextBlob(repoPath, commitRef, "observation.json"),
  ) as ObservationMetadata;

  return {
    commit: await readHistoryCommit(repoPath, commitRef),
    ...metadata,
  };
}

async function readGitTextBlob(
  repoPath: string,
  commitRef: string,
  artifactPath: string,
): Promise<string> {
  const blob = await readGitBlob(repoPath, commitRef, artifactPath);

  return blob.toString("utf8");
}

function openReadModel(repoPath: string): DatabaseSync {
  return new DatabaseSync(getRepositoryLayout(repoPath).readModelPath);
}

function throwReadModelUnavailableError(error: unknown): never {
  if (isMissingReadModelTableError(error)) {
    throw new ReadModelUnavailableError({ cause: error });
  }

  throw error;
}

function isMissingReadModelTableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("no such table");
}
