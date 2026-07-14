import type { DatabaseSync } from "node:sqlite";

export const readModelSchemaVersion = "1";

export function resetSchema(db: DatabaseSync): void {
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
