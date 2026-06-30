import type { SemanticEvent, SemanticSnapshot } from "@silksong-git/core";
import {
  createSemanticSnapshot,
  diffSemanticSnapshots,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { DatabaseSync } from "node:sqlite";

import { readProjectConfig } from "./config.ts";
import {
  readGitBlob,
  readHistoryCommit,
  readObservationCommitRefs,
} from "./git-store.ts";
import { getRepositoryLayout } from "./layout.ts";
import type { ObservationMetadata } from "./observation.ts";
import type { ReadModelCursor } from "./read-model/cursor.ts";
import { createCursor, parseCursor } from "./read-model/cursor.ts";
import {
  applyDisplayFilters,
  getEventVisibility,
} from "./read-model/event-visibility.ts";
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
  HistoricalSemanticEvent,
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

interface EventRow {
  readonly event_id: string;
  readonly event_json: string;
  readonly after_observation_sequence: number;
  readonly event_index: number;
  readonly observation_json: string;
  readonly previous_observation_json: string | null;
}

interface QueryEventsOptions {
  readonly includeFiltered?: boolean;
  readonly includeRawObservations?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

interface EventRowsPage {
  readonly rows: readonly EventRow[];
  readonly nextCursor?: string;
}

interface SnapshotRow {
  readonly snapshot_json: string;
}

interface ObservationRow {
  readonly observation_json: string;
}

type DisplaySemanticEventFilters = Awaited<
  ReturnType<typeof readProjectConfig>
>["displaySemanticEventFilters"];
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

export async function diffReadModelCommits(
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

export async function searchReadModelEvents(
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

function selectEventRows(
  db: DatabaseSync,
  options: QueryEventsOptions,
): EventRowsPage {
  const cursor: ReadModelCursor = parseCursor(options.cursor);
  const queryLimit = options.limit === undefined ? -1 : options.limit + 1;

  const rows = db
    .prepare(
      `
      select
        events.event_id,
        events.event_json,
        events.after_observation_sequence,
        events.event_index,
        after_observations.observation_json as observation_json,
        before_observations.observation_json as previous_observation_json
      from events
      join observations as after_observations
        on after_observations.sequence = events.after_observation_sequence
      left join observations as before_observations
        on before_observations.sequence = events.before_observation_sequence
      where
        events.after_observation_sequence > ?
        or (
          events.after_observation_sequence = ?
          and events.event_index > ?
        )
      order by events.after_observation_sequence asc, events.event_index asc
      limit ?
    `,
    )
    .all(
      cursor.afterObservationSequence,
      cursor.afterObservationSequence,
      cursor.eventIndex,
      queryLimit,
    ) as unknown as EventRow[];

  if (options.limit === undefined || rows.length <= options.limit) {
    return { rows };
  }

  const pageRows = rows.slice(0, options.limit);
  const lastRow = pageRows.at(-1);

  return {
    rows: pageRows,
    ...(lastRow !== undefined && {
      nextCursor: createCursor({
        afterObservationSequence: lastRow.after_observation_sequence,
        eventIndex: lastRow.event_index,
      }),
    }),
  };
}

function selectSearchEventRows(
  db: DatabaseSync,
  query: SearchSemanticEventsInput["query"],
): readonly EventRow[] {
  const conditions = ["? = ?"];
  const parameters: Array<number | string> = [1, 1];

  if (query.itemId !== undefined) {
    conditions.push("events.item_id = ?");
    parameters.push(query.itemId);
  }

  if (query.label !== undefined) {
    conditions.push("events.item_label = ?");
    parameters.push(query.label);
  }

  if (query.type !== undefined) {
    conditions.push("events.item_type = ?");
    parameters.push(query.type);
  }

  if (query.statusTo !== undefined) {
    conditions.push("events.status_to = ?");
    parameters.push(query.statusTo);
  }

  if (query.eventType !== undefined) {
    conditions.push("events.event_type = ?");
    parameters.push(query.eventType);
  }

  if (query.direction !== undefined) {
    conditions.push("events.direction = ?");
    parameters.push(query.direction);
  }

  if (query.text !== undefined) {
    conditions.push("lower(events.search_text) like ?");
    parameters.push(`%${query.text.toLowerCase()}%`);
  }

  return db
    .prepare(
      `
      select
        events.event_id,
        events.event_json,
        events.after_observation_sequence,
        events.event_index,
        after_observations.observation_json as observation_json,
        before_observations.observation_json as previous_observation_json
      from events
      join observations as after_observations
        on after_observations.sequence = events.after_observation_sequence
      left join observations as before_observations
        on before_observations.sequence = events.before_observation_sequence
      where ${conditions.join(" and ")}
      order by events.after_observation_sequence asc, events.event_index asc
    `,
    )
    .all(...parameters) as unknown as EventRow[];
}

function selectRawObservations(
  db: DatabaseSync,
): readonly RawSaveObservation[] {
  const rows = db
    .prepare(
      `
      select observation_json
      from observations
      where ? = ?
      order by sequence asc
    `,
    )
    .all(1, 1) as unknown as ReadonlyArray<{
    readonly observation_json: string;
  }>;

  return rows.map(
    (row) => JSON.parse(row.observation_json) as RawSaveObservation,
  );
}

function selectSnapshot(db: DatabaseSync, commitRef: string): SemanticSnapshot {
  const row = db
    .prepare(
      `
      select snapshot_json
      from snapshots
      where commit_ref = ?
    `,
    )
    .get(commitRef) as unknown as SnapshotRow | undefined;

  if (row === undefined) {
    throw new Error(`No Semantic Snapshot found for commit ${commitRef}.`);
  }

  return JSON.parse(row.snapshot_json) as SemanticSnapshot;
}

function selectObservation(
  db: DatabaseSync,
  commitRef: string,
): RawSaveObservation {
  const row = db
    .prepare(
      `
      select observation_json
      from observations
      where commit_ref = ?
    `,
    )
    .get(commitRef) as unknown as ObservationRow | undefined;

  if (row === undefined) {
    throw new Error(`No Raw Save Observation found for commit ${commitRef}.`);
  }

  return JSON.parse(row.observation_json) as RawSaveObservation;
}

function toHistoricalSemanticEvent(
  row: EventRow,
  filters: DisplaySemanticEventFilters,
): HistoricalSemanticEvent {
  const observation = JSON.parse(row.observation_json) as RawSaveObservation;
  const previousObservation =
    row.previous_observation_json === null
      ? undefined
      : (JSON.parse(row.previous_observation_json) as RawSaveObservation);
  const event = JSON.parse(row.event_json) as SemanticEvent;
  const visibility = getEventVisibility(event, filters);

  return {
    id: row.event_id,
    commit: observation.commit,
    previousCommit: previousObservation?.commit,
    observation,
    event,
    visibility,
  };
}
