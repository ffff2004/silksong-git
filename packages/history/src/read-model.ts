import type { SemanticEvent, SemanticSnapshot } from "@silksong-git/core";
import {
  createSemanticSnapshot,
  diffSemanticSnapshots,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import { DatabaseSync } from "node:sqlite";

import {
  readGitBlob,
  readHistoryCommit,
  readObservationCommitRefs,
} from "./git-store.ts";
import { sha256Hex } from "./hash.ts";
import { getRepositoryLayout } from "./layout.ts";
import type { ObservationMetadata } from "./observation.ts";
import type {
  DiffCommitsResult,
  HistoricalSemanticEvent,
  HistoryResult,
  RawSaveObservation,
  RebuildSemanticReadModelResult,
  SearchSemanticEventsInput,
  SearchSemanticEventsResult,
} from "./types.ts";

const readModelSchemaVersion = "1";

interface RecognizedSnapshotRecord {
  readonly commitRef: string;
  readonly observationSequence: number;
  readonly snapshotId: string;
  readonly snapshot: SemanticSnapshot;
}

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

export function queryReadModelHistory(
  repoPath: string,
  options: QueryEventsOptions = {},
): HistoryResult {
  using db = openReadModel(repoPath);
  const page = selectEventRows(db, options);
  const rawObservations =
    options.includeRawObservations === true
      ? selectRawObservations(db)
      : undefined;

  return {
    events: page.rows.map(toHistoricalSemanticEvent),
    ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor }),
    ...(rawObservations !== undefined && { rawObservations }),
  };
}

export async function diffReadModelCommits(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<DiffCommitsResult> {
  const [from, to] = await Promise.all([
    readHistoryCommit(repoPath, fromRef),
    readHistoryCommit(repoPath, toRef),
  ]);
  using db = openReadModel(repoPath);
  const before = selectSnapshot(db, from.ref);
  const after = selectSnapshot(db, to.ref);
  const observation = selectObservation(db, to.ref);
  const events = diffSemanticSnapshots(before, after).map((event, index) => ({
    id: `${to.ref}:${index}`,
    commit: to,
    previousCommit: from,
    observation,
    event,
    visibility: {
      defaultVisible: true,
      filterReasons: [],
    },
  }));

  return {
    from,
    to,
    before,
    after,
    events,
  };
}

export function searchReadModelEvents(
  repoPath: string,
  input: SearchSemanticEventsInput,
): SearchSemanticEventsResult {
  using db = openReadModel(repoPath);

  return {
    events: selectSearchEventRows(db, input.query).map(
      toHistoricalSemanticEvent,
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

function resetSchema(db: DatabaseSync) {
  db.exec(`
    drop table if exists events;
    drop table if exists snapshots;
    drop table if exists observations;
    drop table if exists read_model_metadata;

    create table read_model_metadata (
      key text primary key,
      value text not null
    );

    create table observations (
      sequence integer primary key,
      commit_ref text not null unique,
      short_ref text not null,
      committed_at text not null,
      observation_json text not null
    );

    create table snapshots (
      snapshot_id text primary key,
      commit_ref text not null unique,
      observation_sequence integer not null,
      snapshot_sha256 text not null,
      snapshot_json text not null
    );

    create table events (
      event_id text primary key,
      before_snapshot_id text not null,
      after_snapshot_id text not null,
      before_commit_ref text not null,
      after_commit_ref text not null,
      before_observation_sequence integer not null,
      after_observation_sequence integer not null,
      event_index integer not null,
      kind text not null,
      event_type text not null,
      direction text not null,
      is_regression integer not null,
      item_id text,
      item_label text,
      section_id text,
      category_id text,
      item_type text,
      status_from text,
      status_to text,
      metric text,
      search_text text not null,
      event_json text not null,
      unique(after_commit_ref, event_index)
    );

    create index events_after_sequence_idx
      on events(after_observation_sequence, event_index);
  `);
}

function insertMetadata(db: DatabaseSync, key: string, value: string) {
  db.prepare("insert into read_model_metadata (key, value) values (?, ?)").run(
    key,
    value,
  );
}

function insertObservation(
  db: DatabaseSync,
  sequence: number,
  observation: RawSaveObservation,
) {
  db.prepare(
    `
    insert into observations (
      sequence,
      commit_ref,
      short_ref,
      committed_at,
      observation_json
    ) values (?, ?, ?, ?, ?)
  `,
  ).run(
    sequence,
    observation.commit.ref,
    observation.commit.shortRef,
    observation.commit.committedAt,
    JSON.stringify(observation),
  );
}

function insertSnapshot(
  db: DatabaseSync,
  snapshotRecord: RecognizedSnapshotRecord,
) {
  const snapshotJson = JSON.stringify(snapshotRecord.snapshot);

  db.prepare(
    `
    insert into snapshots (
      snapshot_id,
      commit_ref,
      observation_sequence,
      snapshot_sha256,
      snapshot_json
    ) values (?, ?, ?, ?, ?)
  `,
  ).run(
    snapshotRecord.snapshotId,
    snapshotRecord.commitRef,
    snapshotRecord.observationSequence,
    sha256Hex(snapshotJson),
    snapshotJson,
  );
}

function insertEvents(
  db: DatabaseSync,
  recognizedSnapshots: readonly RecognizedSnapshotRecord[],
): number {
  let eventCount = 0;

  for (let index = 1; index < recognizedSnapshots.length; index++) {
    const before = recognizedSnapshots[index - 1];
    const after = recognizedSnapshots[index];

    if (before === undefined || after === undefined) {
      continue;
    }

    const events = diffSemanticSnapshots(before.snapshot, after.snapshot);

    for (const [eventIndex, event] of events.entries()) {
      insertEvent(db, {
        before,
        after,
        event,
        eventIndex,
      });
      eventCount++;
    }
  }

  return eventCount;
}

function insertEvent(
  db: DatabaseSync,
  input: {
    readonly before: RecognizedSnapshotRecord;
    readonly after: RecognizedSnapshotRecord;
    readonly event: SemanticEvent;
    readonly eventIndex: number;
  },
) {
  const eventJson = JSON.stringify(input.event);
  const itemColumns = getItemColumns(input.event);

  db.prepare(
    `
    insert into events (
      event_id,
      before_snapshot_id,
      after_snapshot_id,
      before_commit_ref,
      after_commit_ref,
      before_observation_sequence,
      after_observation_sequence,
      event_index,
      kind,
      event_type,
      direction,
      is_regression,
      item_id,
      item_label,
      section_id,
      category_id,
      item_type,
      status_from,
      status_to,
      metric,
      search_text,
      event_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    `${input.after.commitRef}:${input.eventIndex}`,
    input.before.snapshotId,
    input.after.snapshotId,
    input.before.commitRef,
    input.after.commitRef,
    input.before.observationSequence,
    input.after.observationSequence,
    input.eventIndex,
    input.event.kind,
    input.event.eventType,
    input.event.direction,
    input.event.isRegression ? 1 : 0,
    itemColumns.itemId,
    itemColumns.itemLabel,
    itemColumns.sectionId,
    itemColumns.categoryId,
    itemColumns.itemType,
    itemColumns.statusFrom,
    itemColumns.statusTo,
    itemColumns.metric,
    itemColumns.searchText,
    eventJson,
  );
}

function getItemColumns(event: SemanticEvent) {
  if (event.kind === "item") {
    return {
      itemId: toSqliteText(event.item.id),
      itemLabel: toSqliteText(event.item.label),
      sectionId: toSqliteText(event.item.sectionId),
      categoryId: toSqliteText(event.item.categoryId),
      itemType: toSqliteText(event.item.type),
      statusFrom: toSqliteText(event.before.status),
      statusTo: toSqliteText(event.after.status),
      metric: "",
      searchText: [event.item.id, event.item.label, event.item.type].join(" "),
    };
  }

  return {
    itemId: "",
    itemLabel: "",
    sectionId: "",
    categoryId: "",
    itemType: "",
    statusFrom: "",
    statusTo: "",
    metric: event.metric,
    searchText: event.metric,
  };
}

function toSqliteText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function selectEventRows(
  db: DatabaseSync,
  options: QueryEventsOptions,
): EventRowsPage {
  const cursor = parseCursor(options.cursor);
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
    ...(lastRow !== undefined && { nextCursor: createCursor(lastRow) }),
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

function parseCursor(cursor: string | undefined): {
  readonly afterObservationSequence: number;
  readonly eventIndex: number;
} {
  if (cursor === undefined) {
    return {
      afterObservationSequence: 0,
      eventIndex: -1,
    };
  }

  const [afterObservationSequence, eventIndex] = cursor.split(":").map(Number);

  if (
    afterObservationSequence === undefined
    || eventIndex === undefined
    || Number.isNaN(afterObservationSequence)
    || Number.isNaN(eventIndex)
  ) {
    throw new Error("Invalid history cursor.");
  }

  return {
    afterObservationSequence,
    eventIndex,
  };
}

function createCursor(row: EventRow): string {
  return `${row.after_observation_sequence}:${row.event_index}`;
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

function toHistoricalSemanticEvent(row: EventRow): HistoricalSemanticEvent {
  const observation = JSON.parse(row.observation_json) as RawSaveObservation;
  const previousObservation =
    row.previous_observation_json === null
      ? undefined
      : (JSON.parse(row.previous_observation_json) as RawSaveObservation);

  return {
    id: row.event_id,
    commit: observation.commit,
    previousCommit: previousObservation?.commit,
    observation,
    event: JSON.parse(row.event_json) as SemanticEvent,
    visibility: {
      defaultVisible: true,
      filterReasons: [],
    },
  };
}
