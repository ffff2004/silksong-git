import type { SemanticEvent, SemanticSnapshot } from "@silksong-git/core";
import type { DatabaseSync } from "node:sqlite";

import type { readProjectConfig } from "../config.ts";
import type {
  HistoricalSemanticEvent,
  RawSaveObservation,
  SearchSemanticEventsInput,
} from "../types.ts";
import type { ReadModelCursor } from "./cursor.ts";
import { createCursor, parseCursor } from "./cursor.ts";
import { getEventVisibility } from "./event-visibility.ts";
import type { RecognizedSnapshotRecord } from "./types.ts";

interface EventRow {
  readonly event_id: string;
  readonly event_json: string;
  readonly after_observation_sequence: number;
  readonly event_index: number;
  readonly observation_json: string;
  readonly previous_observation_json: string | null;
}

export interface QueryEventsOptions {
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
  readonly commit_ref: string;
  readonly observation_sequence: number;
  readonly snapshot_id: string;
  readonly snapshot_json: string;
}

interface ObservationRow {
  readonly observation_json: string;
}

type DisplaySemanticEventFilters = Awaited<
  ReturnType<typeof readProjectConfig>
>["displaySemanticEventFilters"];

export function selectEventRows(
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

export function selectSearchEventRows(
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

export function selectRawObservations(
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

export function selectMetadataValue(
  db: DatabaseSync,
  key: string,
): string | undefined {
  const row = db
    .prepare(
      `
      select value
      from read_model_metadata
      where key = ?
    `,
    )
    .get(key) as unknown as { readonly value: string } | undefined;

  return row?.value;
}

export function selectLastObservationSequence(db: DatabaseSync): number {
  const row = db
    .prepare(
      `
      select max(sequence) as sequence
      from observations
      where ? = ?
    `,
    )
    .get(1, 1) as unknown as { readonly sequence: number | null };

  return row.sequence ?? 0;
}

export function selectLatestSnapshotRecord(
  db: DatabaseSync,
): RecognizedSnapshotRecord | undefined {
  const row = db
    .prepare(
      `
      select
        snapshot_id,
        commit_ref,
        observation_sequence,
        snapshot_json
      from snapshots
      where ? = ?
      order by observation_sequence desc
      limit 1
    `,
    )
    .get(1, 1) as unknown as SnapshotRow | undefined;

  if (row === undefined) {
    return undefined;
  }

  return {
    commitRef: row.commit_ref,
    observationSequence: row.observation_sequence,
    snapshotId: row.snapshot_id,
    snapshot: JSON.parse(row.snapshot_json) as SemanticSnapshot,
  };
}

export function selectSnapshot(
  db: DatabaseSync,
  commitRef: string,
): SemanticSnapshot {
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

export function selectObservation(
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

export function toHistoricalSemanticEvent(
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
