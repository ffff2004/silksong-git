import type { SemanticEvent } from "@silksong-git/core";
import { diffSemanticSnapshots } from "@silksong-git/core";
import type { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "../hash.ts";
import type { RawSaveObservation } from "../types.ts";
import type { RecognizedSnapshotRecord } from "./types.ts";

export function insertMetadata(
  db: DatabaseSync,
  key: string,
  value: string,
): void {
  db.prepare("insert into read_model_metadata (key, value) values (?, ?)").run(
    key,
    value,
  );
}

export function insertObservation(
  db: DatabaseSync,
  sequence: number,
  observation: RawSaveObservation,
): void {
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

export function insertSnapshot(
  db: DatabaseSync,
  snapshotRecord: RecognizedSnapshotRecord,
): void {
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

export function insertEvents(
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
