# Save History Design

This document is the implementation guide for the planned Silksong save-history fork. It summarizes the accepted design from `CONTEXT.md` and `docs/adr/*.md`; it does not replace either of them.

## Document Roles

The design docs have three separate jobs:

- `CONTEXT.md` defines the domain language: terms such as Encoded Save, Decoded Save, Semantic Snapshot, Semantic Event, Save History Repository, and Display Semantic Event Filter.
- `docs/adr/*.md` records accepted decisions and their rationale.
- `docs/current-design-reference/*.md` describes the current Web implementation and preserved behavior that will be extracted and refactored.
- This document connects the terms and decisions into one implementation map for the workspace, core Module, history Module, CLI, Web UI, and TDD order.

When these documents disagree, prefer the ADR for decision rationale and update this design document to match.

## Current-System References

- `docs/current-design-reference/overview.md` summarizes the current Web app and preserved static behavior.
- `docs/current-design-reference/save-to-semantic.md` details the current save-to-semantic mapping chain used when extracting `packages/core`.

## Goals

The fork should support:

- Watching one local `.dat` save file continuously.
- Creating a manual checkpoint before high-risk in-game actions.
- Creating a local Git-backed Save History Repository for that Watched Save.
- Committing stable Raw Save Observations so future semantic mapping changes can rebuild history.
- Building a SQLite Semantic Read Model from Git history.
- Viewing Semantic Events, semantic diffs, history, reverse event lookup, and restore/export workflows from CLI and local Web UI.
- Preserving the existing static Web UI upload workflow for current-save inspection.
- Sharing one semantic core between CLI, API-connected Web UI, static Web UI, and tests.

## Non-Goals For The First Version

The first version does not need:

- A multi-save repository.
- A multi-save workspace index.
- An interactive terminal UI.
- A generic filter rule language or DSL.
- Direct SQLite schema access from CLI or Web code.
- In-place restore as the default restore mode.

## High-Level Architecture

The fork should become a pnpm workspace:

```txt
packages/core
  decode/parse saves
  build Semantic Snapshots
  diff Semantic Snapshots into Semantic Events
  no DOM, no Git, no SQLite

packages/history
  initialize Save History Repositories
  observe saves
  write raw observation commits
  rebuild/query SQLite Semantic Read Model
  restore Encoded Saves
  start Local History Watch Process

apps/cli
  parse CLI args
  call packages/core and packages/history
  render text or JSON output

apps/web
  existing Vite Web UI frontend
  Static Web Mode for upload-only current-save inspection
  Local History Web Mode through compatible local HTTP endpoints
  frontend serve mechanism intentionally separate from history process
```

This follows ADR-0011. The important seam is `packages/core`: Web, CLI, and history code should not need to understand raw save shapes such as `sceneBool`, `savedData[]`, quest state fields, journal counters, relic fields, or quill state internals.

## Data Ownership

Git and SQLite have different responsibilities:

```txt
Git Save History Repository
  canonical raw history
  restore source
  save.dat
  decoded-save.json
  observation.json
  .silksong-git/config.json

SQLite Semantic Read Model
  rebuildable semantic index
  complete Semantic Snapshots
  complete Semantic Events
  event-to-commit lookup
  display filter metadata
  mapper/version stamps
```

Git stores Raw Save Observations, not semantic facts. SQLite stores semantic interpretation and can be rebuilt from Git. This is the central decision in ADR-0001.

## Repository Layout

Each Save History Repository tracks one Watched Save:

```txt
history-repo/
  save.dat
  decoded-save.json
  observation.json
  .gitignore
  .silksong-git/
    config.json
    read-model.sqlite
    write.lock
```

`save.dat`, `decoded-save.json`, `observation.json`, and `.silksong-git/config.json` are committed. `read-model.sqlite` is ignored by Git because it is rebuildable. `write.lock` is ignored because it is a runtime repository-write lock.

`save.dat` is the canonical restore artifact. `decoded-save.json` is raw decoded JSON for inspection and semantic rebuilds. `observation.json` stores Observation Metadata such as observation time, source path, hashes, previous commit, decoder version, and save/game schema context.

## Observation Flow

The watcher should use this flow:

```txt
file changed or startup observation requested
  -> wait for debounce when required
  -> wait for file stability
  -> read bytes
  -> decode Encoded Save
  -> identify/parse Decoded Save
  -> apply Capture Policy
  -> commit Raw Save Observation
  -> update Semantic Read Model when semantic mapping is possible
```

A manual checkpoint uses the same decode, classify, commit, and read-model update behavior, but is triggered by the user instead of the file watcher. It does not wait for watcher debounce and bypasses the minimum commit interval. Committing unchanged bytes still requires explicit user intent.

The watcher attaches its file watch backend before requesting its startup observation, then treats startup as a synthetic dirty event. Startup skips `debounceWriteMs` but still waits for file stability before calling the observation path. Real filesystem events wait for `debounceWriteMs`, then use the same stability check.

File stability is based on the Watched Save being stat-able as a file with unchanged `size` and `mtimeMs` across stability probes. A short internal probe interval is sufficient for the first version; a bounded internal stability timeout prevents one unstable file from blocking the watcher forever. Stability timeout, missing file, and stat/read failures are reported as Watcher Errors and do not stop the process. Watch backend startup or runtime failure is a process-level fatal error.

Filesystem events are not commit units. The watcher uses a single-flight observation loop with a dirty bit: multiple events before stability are coalesced, and events arriving while an observation is running schedule one more observation pass after the current pass finishes. Each observation pass reads the current Watched Save through the history observation path; the watcher does not cache bytes from earlier events.

Decode failure is a Watcher Error and must not be committed. It usually means a half-written file, corrupted input, wrong path, or non-save file.

Decode success with unknown save shape becomes an Unrecognized Schema Observation. It is committed with `save.dat`, `decoded-save.json`, and `observation.json`, but does not produce Semantic Snapshots or Semantic Events until a future rebuild supports that Save Schema Version.

`decoded-save.json` stores only the raw Decoded Save payload returned as `decoded.decodedSave` by `packages/core`. `decoderVersion` is Observation Metadata and belongs in `observation.json`; it must not be treated as a Save Schema Version.

`DecodeEncodedSaveError` is a Watcher Error and produces no Raw Save Observation. `UnrecognizedSaveSchemaError` means decoding succeeded but `packages/core` cannot identify the Decoded Save shape; it should produce a committed Unrecognized Schema Observation.

## Capture Policy

Capture Policy controls Git raw-history fidelity. It is separate from Display Semantic Event Filters.

First-version settings:

```ts
{
  debounceWriteMs: number;
  minCommitIntervalMs: number;
}
```

If multiple stable save changes occur inside `minCommitIntervalMs`, only the latest Raw Save Observation is committed. This is an explicit fidelity trade-off: the user gets fewer commits but loses intermediate raw states. A value less than or equal to zero disables minimum-interval suppression.

When a watcher-triggered observation is skipped by the minimum commit interval, the result should include the next allowed observation time so the watcher can schedule one deferred observation. The deferred observation skips debounce because the interval has already elapsed, but it still waits for file stability and reads the current Watched Save at that time. If the file has returned to the last committed bytes, the deferred observation is skipped as unchanged. The watcher keeps at most one deferred observation timer and merges later file events into the same pending opportunity.

Manual checkpoints always bypass minimum-interval suppression. They do not commit unchanged Encoded Save bytes unless the user explicitly allows unchanged checkpoints. They still must decode successfully, use the same schema handling, and acquire the same repository write lock as watcher observations.

Display filters must not decide whether Git commits happen.

## Semantic Model

Semantic Snapshots cover:

```txt
main
essentials
bosses
mini-bosses
completion
wishes
journal
scenes
```

They also include Save Summary Metrics:

```txt
completionPercentage
playTime
rosaries
shellShards
permadeathMode
```

Raw `playerData` fields map into semantic Save Summary Metrics:

```txt
completionPercentage -> completionPercentage
playTime             -> playTime
geo                  -> rosaries
ShellShards          -> shellShards
permadeathMode       -> permadeathMode
```

A Semantic Event is an item-level state transition between two Semantic Snapshots, not a raw field diff. Events can include Source References back to Decoded Save fields and mapping data for debugging.

Examples:

```txt
Mask Shard #2: missing -> done
Citadel Seeker: missing -> accepted
Citadel Seeker: accepted -> completed
Some Journal Entry: 2/5 -> 5/5
Needle Upgrade: 1 -> 2
Rosaries: 120 -> 180
```

Regressions are recorded too:

```txt
Mask Shard #2: done -> missing
Needle Upgrade: 3 -> 2
```

Regression Events can happen after restore, rollback, or save replacement.

## Numeric Event Rules

Numeric diffing should produce user-meaningful events:

- Threshold items produce default-visible events when they cross meaningful thresholds.
- Journal entries produce events when they reach required kills; partial changes can be recorded but filtered by default.
- Level or stage items produce events for each stage crossing.
- Save Summary Metric changes are recorded as complete Semantic Events, but noisy ones are hidden by default.
- Currency-only changes are hidden by default.
- Backward numeric transitions are recorded as Regression Events.

## Display Semantic Event Filters

SQLite stores the complete set of Semantic Events. Display Semantic Event Filters are applied at query time for default CLI/UI views and notifications.

First-version filter shape should stay explicit rather than becoming a rule language:

```ts
{
  hideEventTypes: string[];
  hideItemTypes: string[];
  hideSummaryMetrics: string[];
  minJournalDelta?: number;
  hideCurrencyOnlyEvents: boolean;
}
```

Queries should support an option such as `includeFiltered` to show hidden events.

## Version Stamps

Version Stamps explain how raw and semantic artifacts were produced:

```txt
decoderVersion
saveSchemaVersion
gameVersion?
platform?
platformBuildId?
mappingDataVersion
semanticCoreVersion
configHash
```

`saveSchemaVersion` is the primary branch point for parser and mapping behavior. It is the tool-recognized Decoded Save shape, not the in-game version or a store build number. `gameVersion` records the in-game displayed version when available, such as `1.0.30000`. `platform` records the distribution platform when known, such as `steam`. `platformBuildId` records platform-specific build provenance when known, such as Steam build ID `22479045`. `configHash` captures the Effective Config relevant to display filtering and query behavior.

Parser and mapper selection should branch on `saveSchemaVersion` first. `gameVersion` and `platformBuildId` can help identify or explain a schema, but neither should replace `saveSchemaVersion`.

These stamps let rebuilds detect stale SQLite data and explain why the same raw observation may produce different events under a newer mapper.

## Config Model

Config is resolved into an Effective Config:

```txt
CLI args > Project Config > built-in defaults
```

Recommended locations:

```txt
Project Config:
  history-repo/.silksong-git/config.json
```

First-version Project Config fields:

```ts
{
  watchedSavePath: string;
  capturePolicy: {
    debounceWriteMs: number;
    minCommitIntervalMs: number;
  };
  displaySemanticEventFilters: {
    hideEventTypes: string[];
    hideItemTypes: string[];
    hideSummaryMetrics: string[];
    minJournalDelta?: number;
    hideCurrencyOnlyEvents: boolean;
  };
  restore: {
    backupDirectory?: string;
  };
}
```

The local HTTP host is fixed to `127.0.0.1` as a security boundary and is not a Project Config field. The local API port is a runtime binding. HTTP defaults to port `0` so the operating system assigns an available port; `--port` may provide an explicit port from 1 through 65535. The running process reports the concrete endpoint it bound to. The port only applies when the Local History Watch Process starts its optional HTTP Adapter.

## Core Module Interface

`packages/core` should expose a small deep Module interface:

```ts
import {
  createSemanticSnapshot,
  decodeEncodedSave,
  diffSemanticSnapshots,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";

decodeEncodedSave(bytes: ArrayBuffer | Uint8Array): DecodedEncodedSave;

interface DecodedEncodedSave {
  decodedSave: unknown;
  version: DecodedSaveDecoderVersion;
}

interface DecodedSaveDecoderVersion {
  decoderVersion: string;
}

parseDecodedSave(input: unknown): ParsedDecodedSave;

interface ParsedDecodedSave {
  decodedSave: DecodedSave;
  version: DecodedSaveVersion;
}

interface DecodedSaveVersion {
  saveSchemaVersion: string;
  gameVersion?: string;
  platform?: string;
  platformBuildId?: string;
}

getBuiltinMappingData(): MappingData;

createSemanticSnapshot(
  parsedSave: ParsedDecodedSave,
  mappingData: MappingData,
  options?: SnapshotOptions,
): SemanticSnapshot;

interface SnapshotOptions {
  configHash?: string;
}

diffSemanticSnapshots(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
): readonly SemanticEvent[];
```

Callers should import `packages/core` only through the package root (`@silksong-git/core`), not through `@silksong-git/core/src/...`.

The implementation may contain helpers such as:

```txt
getSaveDataValue
getUnlocked
getSaveFileFlags
collectAllItems
normalizeSceneFlag
```

Those helpers should not be external Interfaces. Exposing them would leak raw save structure and make the core Module shallow.

`createSemanticSnapshot` accepts `MappingData` instead of loading it implicitly. This keeps tests and callers able to provide fixture mapping data through the same seam.

## History Module Interface

`packages/history` should expose a small deep Module interface:

```ts
initSaveHistory(input: InitSaveHistoryInput): Promise<InitSaveHistoryResult>;

observeSave(input: ObserveSaveInput): Promise<ObserveSaveResult>;

rebuildSemanticReadModel(
  input: RebuildSemanticReadModelInput,
): Promise<RebuildSemanticReadModelResult>;

queryHistory(input: QueryHistoryInput): Promise<HistoryResult>;

queryRawObservations(
  input: QueryRawObservationsInput,
): Promise<RawObservationHistoryResult>;

diffCommits(input: DiffCommitsInput): Promise<DiffCommitsResult>;

searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult>;

getSaveState(input: GetSaveStateInput): Promise<GetSaveStateResult>;

readEncodedSave(
  input: ReadEncodedSaveInput,
): Promise<ReadEncodedSaveResult>;

restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult>;

startLocalHistoryWatchProcess(
  input: StartLocalHistoryWatchProcessInput,
): Promise<LocalHistoryWatchProcess>;

interface InitSaveHistoryInput {
  repoPath: string;
  watchedSavePath: string;
  config?: ProjectConfigOverrides;
}

interface InitSaveHistoryResult {
  repoPath: string;
  configPath: string;
}

interface ObserveSaveInput {
  repoPath: string;
  observedAt?: Date;
  trigger?: "watcher" | "manualCheckpoint";
  message?: string;
  allowUnchanged?: boolean;
}

type ObserveSaveResult =
  | {
      status: "committed";
      observation: RawSaveObservation;
      semanticUpdate: SemanticUpdateResult;
    }
  | {
      status: "skipped";
      reason: "unchanged";
      encodedSha256: string;
    }
  | {
      status: "skipped";
      reason: "minimumCommitInterval";
      encodedSha256: string;
      nextAllowedAt: string;
    }
  | {
      status: "watcherError";
      error: WatcherError;
    };

type SemanticUpdateResult =
  | {
      status: "updated";
      snapshotId: string;
      eventCount: number;
      events: readonly HistoricalSemanticEvent[];
    }
  | {
      status: "notAvailable";
      reason: "unrecognizedSchema" | "readModelUnavailable";
    };

interface HistoryCommit {
  ref: string;
  shortRef: string;
  committedAt: string;
}

interface RawSaveObservation {
  commit: HistoryCommit;
  observedAt: string;
  trigger: "watcher" | "manualCheckpoint";
  message?: string;
  sourcePath: string;
  encodedSha256: string;
  decodedSha256: string;
  previousCommit?: string;
  decoderVersion: string;
  schema:
    | {
        status: "recognized";
        saveSchemaVersion: string;
        gameVersion?: string;
        platform?: string;
        platformBuildId?: string;
      }
    | {
        status: "unrecognized";
        reason: string;
      };
}

interface HistoricalSemanticEvent {
  id: string;
  commit: HistoryCommit;
  previousCommit?: HistoryCommit;
  observation: RawSaveObservation;
  snapshotSummary: SaveSummaryMetrics;
  event: SemanticEvent;
  visibility: {
    defaultVisible: boolean;
    filterReasons: readonly string[];
  };
}

interface RebuildSemanticReadModelInput {
  repoPath: string;
}

interface RebuildSemanticReadModelResult {
  observationCount: number;
  recognizedObservationCount: number;
  unrecognizedObservationCount: number;
  snapshotCount: number;
  eventCount: number;
}

interface QueryHistoryInput {
  repoPath: string;
  includeFiltered?: boolean;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

interface HistoryResult {
  events: readonly HistoricalSemanticEvent[];
  nextCursor?: string;
}

interface QueryRawObservationsInput {
  repoPath: string;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

interface RawObservationHistoryEntry {
  observation: RawSaveObservation;
  snapshotSummary: SaveSummaryMetrics | null;
}

interface RawObservationHistoryResult {
  entries: readonly RawObservationHistoryEntry[];
  nextCursor?: string;
}

interface DiffCommitsInput {
  repoPath: string;
  fromRef: string;
  toRef: string;
  includeFiltered?: boolean;
}

interface DiffCommitsResult {
  from: HistoryCommit;
  to: HistoryCommit;
  before: SemanticSnapshot;
  after: SemanticSnapshot;
  events: readonly HistoricalSemanticEvent[];
}

interface SearchSemanticEventsInput {
  repoPath: string;
  query: {
    itemId?: string;
    label?: string;
    type?: string;
    statusTo?: SemanticSnapshotItemStatus;
    eventType?: string;
    direction?: SemanticEventDirection;
    text?: string;
  };
  includeFiltered?: boolean;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

interface SearchSemanticEventsResult {
  events: readonly HistoricalSemanticEvent[];
  nextCursor?: string;
}

type SaveStateSelector =
  | { kind: "latest" }
  | { kind: "commit"; commitRef: string };

interface GetSaveStateInput {
  repoPath: string;
  selector: SaveStateSelector;
}

type GetSaveStateResult =
  | {
      status: "available";
      observation: RawSaveObservation;
      decodedSave: DecodedSave;
      semanticSnapshot: SemanticSnapshot | null;
    }
  | { status: "empty" };

interface ReadEncodedSaveInput {
  repoPath: string;
  commitRef: string;
}

interface ReadEncodedSaveResult {
  commit: HistoryCommit;
  encodedBytes: Uint8Array;
  encodedSha256: string;
  suggestedFileName: string;
}

type RestoreTarget =
  | {
      kind: "path";
      path: string;
      overwrite?: boolean;
    }
  | {
      kind: "inPlace";
      confirmation: "restore-watched-save";
      backupDirectory?: string;
      expectedCurrent?:
        | { status: "present"; encodedSha256: string }
        | { status: "missing" };
    };

interface RestoreEncodedSaveInput {
  repoPath: string;
  commitRef: string;
  target: RestoreTarget;
}

interface RestoreEncodedSaveResult {
  commit: HistoryCommit;
  targetPath: string;
  writtenSha256: string;
  backupPath?: string;
}

interface StartLocalHistoryWatchProcessInput {
  repoPath: string;
  http?: {
    port?: number;
  };
  // Existing watcher system-boundary test seams are omitted here.
}

interface LocalHistoryWatchProcess {
  repoPath: string;
  http?: {
    endpoint: string;
    token: string;
  };
  getWatcherStatus(): LocalHistoryWatcherStatus;
  stop(): void | Promise<void>;
}

interface LocalHistoryWatcherStatus {
  status: "running";
  activity: "idle" | "pending" | "observing";
  observationRevision: number;
  startedAt: string;
  repoPath: string;
  watchedSavePath: string;
  capturePolicy: ProjectConfig["capturePolicy"];
  lastObservation?:
    | {
        cause: "startup" | "change" | "deferred";
        completedAt: string;
        status: "committed";
        commit: HistoryCommit;
        eventCount: number;
        semanticStatus: "updated" | "notAvailable";
      }
    | {
        cause: "startup" | "change" | "deferred";
        completedAt: string;
        status: "skipped";
        reason: "unchanged" | "minimumCommitInterval";
        nextAllowedAt?: string;
      }
    | {
        cause: "startup" | "change" | "deferred";
        completedAt: string;
        status: "watcherError";
        error: WatcherError;
      };
}
```

Git, SQLite, file watching, config loading, and local HTTP are implementation details or internal Adapters behind this Interface.

`queryHistory`, `diffCommits`, and `searchSemanticEvents` should return Semantic Events with their commit, Raw Save Observation metadata, and the after-Snapshot `SaveSummaryMetrics`. CLI and Web callers should not need separate Git or SQLite lookups to explain where an event came from or issue one Save State request per displayed commit. `queryRawObservations` returns entries that pair each unchanged `RawSaveObservation` with its `SaveSummaryMetrics`, or `null` for an Unrecognized Schema Observation. It remains a separate paginated Interface because Raw Save Observations and Semantic Events are different ordered histories; one cursor must not ambiguously paginate both.

Display Semantic Event Filters apply consistently to `queryHistory`, `diffCommits`, and `searchSemanticEvents`. Default calls return default-visible events; `includeFiltered: true` returns hidden events as well, with `visibility.filterReasons` explaining why they are hidden by default.

The SQLite schema is not public. CLI and Web callers must use `queryHistory`, `queryRawObservations`, `diffCommits`, and `searchSemanticEvents`; they must not query tables directly. Git command details are not public either; save-state lookup, export, restore, and history lookup go through `packages/history`.

`queryHistory`, `queryRawObservations`, and `searchSemanticEvents` support opaque cursor pagination and an explicit `asc` or `desc` order. Existing Interface and CLI behavior defaults to `asc`; the local HTTP Adapter requests `desc` by default for recent-first Web views. A cursor is valid only with the query, filters, and order that produced it. `searchSemanticEvents` accepts structured query fields as its stable Interface. Free-text `text` search supports the CLI `--event` convenience, but Web and programmatic callers should prefer structured fields.

`getSaveState` first resolves `latest` or a caller-supplied ref to one immutable observation commit, then reads every artifact by that fixed commit. It never reads a moving `HEAD` repeatedly and never triggers an observation. An empty repository is a normal `empty` result. An unrecognized observation returns its Decoded Save with `semanticSnapshot: null`; a recognized observation whose read-model snapshot is unavailable reports `ReadModelUnavailableError` rather than silently remapping.

`readEncodedSave` returns the exact committed `save.dat` bytes as `Uint8Array`; it does not write a Restore Target. Its suggested filename uses only a sanitized basename stem from Project Config `watchedSavePath`, the canonical short commit SHA, and a `.dat` suffix. The directory part of `watchedSavePath` and the caller's untrusted ref are never copied into the filename.

HTTP in-place restore requires `expectedCurrent`, while the existing CLI in-place restore may omit it to preserve its current explicit-confirmation workflow. When present, history acquires `write.lock`, reads the actual Watched Save, and verifies that it is either missing or has the expected hash before backup or overwrite. A mismatch produces `RestoreConflictError` without creating a backup or writing the Watched Save.

Local History Web Mode normally obtains the `present` precondition from the latest committed Raw Save Observation, not from the selected restore source and not from a fresh uncommitted file read. This intentionally requires the watcher, latest Save State, and Watched Save bytes to be synchronized before rollback, preventing an uncaptured game write from being overwritten. The Web client does not add a current-file preflight endpoint or force override. It may send the existing `missing` precondition only after the user explicitly states that the Watched Save is missing; the server remains the authority that verifies absence.

`packages/history` consumes `packages/core` only through its public package-root Interface:

```ts
const decoded = decodeEncodedSave(encodedBytes);
// decoded.version.decoderVersion -> observation.json metadata

let parsed: ParsedDecodedSave;
try {
  parsed = parseDecodedSave(decoded.decodedSave);
} catch (error) {
  if (error instanceof UnrecognizedSaveSchemaError) {
    return commitUnrecognizedSchemaObservation({
      decodedSave: decoded.decodedSave,
      decoderVersion: decoded.version.decoderVersion,
      encodedBytes,
    });
  }
  throw error;
}

const mappingData = getBuiltinMappingData();
const snapshot = createSemanticSnapshot(parsed, mappingData, {
  configHash,
});
```

Rebuilding the Semantic Read Model iterates Raw Save Observation commits from oldest to newest, parses each `decoded-save.json`, creates Semantic Snapshots for recognized schemas, and calls `diffSemanticSnapshots` between adjacent recognized snapshots. Display Semantic Event Filters are applied when querying, not when committing Git history and not inside `packages/core`.

## Local History Watch Process

One Local History Watch Process owns:

```txt
watching the Watched Save
committing Raw Save Observations
updating SQLite Semantic Read Model
serving local HTTP endpoints when the HTTP Adapter is enabled
```

`watch start` is a singleton per Save History Repository. No second process should independently watch the same repository and write Git or SQLite.

The watcher owns a long-lived `.silksong-git/watch.lock` while it is running. The lock file should contain diagnostic JSON such as process id, start time, repository path, Watched Save path, and command name. A lock conflict fails startup with a clear message. The first version should not automatically remove stale watch locks, because cross-platform process identity and PID reuse make automatic cleanup risky.

All history writers must acquire one Save History Repository write lock before mutating Git artifacts or SQLite. This includes watcher observations and manual checkpoints.

`watch.lock` and `write.lock` have different responsibilities. `watch.lock` prevents a second watcher for the same repository. `write.lock` protects short Git and SQLite write transactions. Offline checkpoint, restore, and rebuild commands may run while the watcher is active, but they must acquire `write.lock` and serialize with watcher observations.

`startLocalHistoryWatchProcess` should read Project Config once at startup and use that config snapshot for the running watcher. Config changes require restarting the watcher to take effect. One-shot Offline Commands continue to read Project Config when they run.

The Local History Watch Process produces structured process events from `packages/history`; CLI output is only an Adapter over those events. The process event stream may include the complete `ObserveSaveResult`, while CLI JSON output should use compact stable summaries. Started events include the repository path, Watched Save path, Capture Policy snapshot, and, when HTTP is enabled, the concrete endpoint and bearer token. The HTTP credentials appear only in this one started event.

The process shuts down gracefully. Shutdown stops accepting new file events, cancels pending debounce/stability work when no observation has started, waits for any running observation to finish, releases `watch.lock`, and emits a stopped event. It does not hard-cancel an observation that may be mutating Git or SQLite.

Local HTTP endpoints are thin Adapters over `packages/history`. They call history functions and do not directly query SQLite or run Git operations. In the first version, `watch start` does not expose HTTP by default; `watch start --http` enables the HTTP Adapter inside the same Local History Watch Process. Enabling HTTP must not create a second history writer.

The Web UI frontend is a client of these endpoints. Serving the frontend is not part of the single-writer invariant: implementation and debugging can use Vite, and a later release can add static hosting or a small frontend-serving process without changing the Local History Watch Process contract.

CLI history/diff/search/restore commands can also run as Offline Commands that read the Save History Repository and Semantic Read Model directly through `packages/history`.

## Local HTTP Adapter

ADR-0018 defines the security and lifecycle boundary. The Adapter uses Hono, `@hono/node-server`, Zod, and `@hono/zod-openapi` inside `packages/history`. Hono handles HTTP concerns only; route handlers call public history Interfaces. OpenAPI-aware route definitions drive strict runtime request validation and generate the ignored, on-demand `docs/generated/local-http-api.openapi.json` artifact through `pnpm generate:openapi`; response schemas are checked against public history DTOs. The generated document is not an additional watch-process endpoint. `packages/history` exposes the inferred Hono app type through a browser-safe type-only subpath so `apps/web` can use `hono/client` without importing the server app, Node modules, Git, SQLite, or watcher internals. Compile-time Hono RPC types and OpenAPI documentation do not replace runtime compatibility discovery.

The server binds only `http://127.0.0.1`; the host is fixed in the HTTP Adapter and is not configurable. The default port is `0`; `--port` accepts an explicit integer from 1 through 65535. The port and credentials are never persisted. The first version does not support HTTPS, IPv6, LAN binding, a host CLI flag, or runtime token rotation.

Each process start generates a new cryptographically secure random bearer token of at least 256 bits, encoded as unpadded base64url and held only in memory. All actual API requests, including reads and compatibility discovery, require strict `Authorization: Bearer <token>` authentication with constant-time comparison. The token is not accepted in a URL, cookie, or alternate authentication scheme. The CLI reports endpoint and token as separate fields exactly once; losing the token requires restarting the watch process.

Standard CORS allows any origin without credentials. It permits only the required methods plus `Authorization` and `Content-Type` request headers, and exposes `Content-Disposition`, `ETag`, and `Retry-After`. Unauthenticated `OPTIONS /api/v1/*` is the only authentication exception and returns no repository state. Browser Local Network Access permission belongs to P6 Web connection behavior; the server does not return superseded Private Network Access headers.

First-version routes are:

| Method | Route                              | Public history behavior                                   |
| ------ | ---------------------------------- | --------------------------------------------------------- |
| GET    | `/api/v1/meta`                     | API compatibility and capability discovery                |
| GET    | `/api/v1/watcher`                  | Current coarse watcher status                             |
| GET    | `/api/v1/save?selector=latest`     | Latest committed Raw Save Observation state               |
| GET    | `/api/v1/save?commit=<ref>`        | State at one observation commit                           |
| GET    | `/api/v1/history`                  | Paginated Semantic Event history                          |
| GET    | `/api/v1/observations`             | Paginated Raw Save Observation history                    |
| GET    | `/api/v1/diff?from=<ref>&to=<ref>` | Semantic diff between two commits                         |
| GET    | `/api/v1/search?...`               | Structured paginated Semantic Event search                |
| POST   | `/api/v1/checkpoints`              | Manual checkpoint through `observeSave`                   |
| GET    | `/api/v1/export?commit=<ref>`      | Exact committed Encoded Save bytes                        |
| POST   | `/api/v1/restores/in-place`        | Confirmed preconditioned restore to the Watched Save only |

Commit refs stay in query parameters rather than path segments because valid Git refs may contain `/`. History resolves every ref to one canonical immutable commit before reading multiple artifacts. Route handlers never concatenate untrusted refs into shell commands or filesystem paths.

`/meta` returns this compatibility shape:

```ts
{
  api: {
    name: "silksong-git-local-history";
    version: { major: 1; minor: 1 };
  };
  repoPath: string;
  watchedSavePath: string;
  capabilities: readonly (
    | "watcherStatus"
    | "saveState"
    | "history"
    | "rawObservations"
    | "diff"
    | "search"
    | "checkpoint"
    | "exportEncodedSave"
    | "restoreInPlace"
  )[];
}
```

Clients require the same API major, a server minor at least as high as the client requires, and the complete documented capability set. The first Web client does not implement partial-feature degradation because its local server ships from the same project. Unknown additional fields and capabilities are ignored. Capabilities describe implemented protocol support, not transient availability. API 1.1 requires History and Search events to include their after-Snapshot Summary, and Raw Observation history entries to include `SaveSummaryMetrics | null`. The first version does not report a placeholder tool version, process instance id, or persistent repository UUID. API responses use `Cache-Control: no-store`.

History, search, and Raw Observation queries default to `limit=100` in HTTP, accept 1 through 1000, and default to `order=desc`. Cursors are opaque and valid only with the same query, filters, and order. Search must include at least one actual structured or text query field. History returns only Semantic Events; Raw Observations use their own Interface, endpoint, and cursor.

Checkpoint JSON is strict `{ message?, allowUnchanged? }`. A committed or skipped checkpoint returns `200`; decode failure returns `422 save_decode_failed`; read failure returns `503 watched_save_unavailable`; and a committed observation whose semantic update is unavailable remains a successful commit result. HTTP does not add a private mutation queue or automatic POST retry; it uses the existing repository write lock and returns `409 repository_busy` with `Retry-After` after the existing lock-acquisition window.

In-place restore JSON is strict and includes:

```ts
{
  commitRef: string;
  confirmation: "restore-watched-save";
  expectedCurrent:
    | { status: "present"; encodedSha256: string }
    | { status: "missing" };
}
```

The 64-character lowercase SHA-256 precondition normally comes from the latest committed Raw Save Observation, binding user confirmation to a watcher-synchronized state rather than allowing an uncaptured current file to be overwritten. A mismatch returns `409 restore_conflict` before backup or write. An explicit missing-file flow sends `{ status: "missing" }`; it succeeds only when the server verifies that the Watched Save is absent and consequently produces no original-file backup. HTTP does not expose restore-to-path or a force override. The first version does not implement `Idempotency-Key`; the restore precondition and unchanged-checkpoint behavior cover the normal duplicate-submission cases, and the Web client must not automatically retry POST requests.

Export responds with the exact Git `save.dat` bytes, `application/octet-stream`, a strong ETag based on Encoded Save SHA-256, `Content-Length`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. `Content-Disposition` uses a sanitized `<watched-save-stem>.<canonical-short-sha>.dat` filename, with an ASCII fallback and encoded Unicode form when needed. It never includes the watched directory or caller-supplied ref.

Watcher status is a current-state snapshot, not a lossless event stream. It reports `running`, activity as `idle`, `pending`, or `observing`, process paths and Capture Policy, an `observationRevision` incremented once for each completed observation, and only the latest compact observation summary. `pending` covers debounce, stability wait, and deferred work without exposing watcher internals. When revision changes, Web refreshes Save State and consumes persistent history with cursors; skipped observations and transient Watcher Errors are not a durable audit log.

POST bodies require `application/json`, are limited to 16 KiB, and use strict Zod objects. Commit refs are limited to 1024 characters, messages and search strings to 1000, and cursors to 4096. Boolean query fields accept only `true` or `false`. Validation does not return raw Zod objects or unsafe values.

Successful JSON responses directly use public history DTOs where applicable. Errors use both a coarse standard HTTP status and a stable `{ error: { code, message, details? } }` body:

| HTTP | Error code                      | Meaning                                                        |
| ---- | ------------------------------- | -------------------------------------------------------------- |
| 400  | `invalid_request`               | Invalid validated input, confirmation, cursor, or option set   |
| 401  | `unauthorized`                  | Missing, malformed, or incorrect bearer token                  |
| 404  | `route_not_found`               | No matching API route                                          |
| 404  | `commit_not_found`              | Ref cannot resolve to a commit                                 |
| 404  | `observation_not_found`         | Commit exists but is not a Raw Save Observation                |
| 405  | `method_not_allowed`            | Known route does not support the method                        |
| 408  | `request_timeout`               | Request headers or body were not received in time              |
| 409  | `repository_busy`               | Existing write-lock acquisition window expired                 |
| 409  | `restore_conflict`              | Actual Watched Save does not match the confirmed precondition  |
| 413  | `payload_too_large`             | Request body exceeds 16 KiB                                    |
| 415  | `unsupported_media_type`        | POST body is not `application/json`                            |
| 422  | `save_decode_failed`            | Manual checkpoint cannot decode the current Watched Save       |
| 500  | `restore_configuration_invalid` | Project Config restore backup directory is invalid             |
| 500  | `restore_backup_failed`         | Restore cannot create its required backup                      |
| 500  | `restore_write_failed`          | Restore cannot write the Watched Save                          |
| 500  | `restore_verification_failed`   | Restore write-back hash differs from the intended Encoded Save |
| 500  | `internal_error`                | Unclassified server failure                                    |
| 503  | `watched_save_unavailable`      | Manual checkpoint cannot read the Watched Save                 |
| 503  | `read_model_unavailable`        | Semantic Read Model is missing, stale, or unreadable           |

Responses never expose stack traces, Git stderr, credentials, Zod input values, or internal absolute paths. The server may add new error codes in a compatible minor version; clients degrade to the HTTP status and safe message for unknown codes.

Known 4xx responses are returned only to the client. Known 5xx domain failures and unexpected handler failures emit a sanitized nonfatal `httpRequestError` process event containing only method, route path without query, status, code, and safe message. An unrecoverable listener failure is a fatal `httpServerFailure`; a legal but unavailable explicit port is a runtime start failure, while malformed port syntax is CLI usage failure.

Shutdown stops new HTTP work and idle connections before waiting for handlers already inside public history Interfaces. Client disconnect does not cancel a mutation that may have changed Git, SQLite, or the Watched Save. HTTP and watcher work finish before `watch.lock` is released.

## CLI Command Set

ADR-0010 decides that the first CLI is object-grouped and lifecycle-oriented. The command grammar below is the implementation map for that decision.

First-version commands:

| Group     | Action       | User-facing object          | Responsibility                                                                                  |
| --------- | ------------ | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `repo`    | `init`       | Save History Repository     | Create a single-save Save History Repository and Project Config.                                |
| `save`    | `decode`     | Encoded Save                | Decode one save to raw Decoded Save JSON for debugging.                                         |
| `save`    | `snapshot`   | Encoded Save                | Decode and map one save without writing Git history.                                            |
| `watch`   | `start`      | Local History Watch Process | Start watching the Watched Save, updating history, and optionally serving local HTTP endpoints. |
| `history` | `list`       | Semantic Events             | Show Semantic Event history.                                                                    |
| `history` | `diff`       | Semantic Snapshots/Events   | Compare two commits through Semantic Snapshots.                                                 |
| `history` | `search`     | Semantic Events             | Find events and corresponding commits.                                                          |
| `history` | `checkpoint` | Raw Save Observation        | Commit the current Watched Save as a manual checkpoint.                                         |
| `history` | `restore`    | Encoded Save restore        | Write a commit's `save.dat` to an explicit Restore Target.                                      |
| `history` | `rebuild`    | Semantic Read Model         | Rebuild the SQLite Semantic Read Model from Git raw observations.                               |
| `ui`      | `open`       | Web UI client               | Open the Web UI client and connect it to a local endpoint when available.                       |

First-version command forms:

```txt
silksong-git repo init --save <save.dat> --repo <history-repo> [--json]

silksong-git save decode <save.dat> [--out <decoded-save.json>] [--compact] [--schema-check]
silksong-git save snapshot <save.dat> --json

silksong-git watch start [--repo <history-repo>] [--jsonl] [--http] [--port <port>]

silksong-git history list [--repo <history-repo>] [--limit <n>] [--cursor <cursor>] [--include-filtered] [--json]
silksong-git history diff <from> <to> [--repo <history-repo>] [--include-filtered] [--json]
silksong-git history search [--repo <history-repo>] [--event <text>] [--item-id <id>] [--label <text>] [--type <type>] [--status-to <status>] [--direction <direction>] [--include-filtered] [--json]
silksong-git history checkpoint [--repo <history-repo>] [--message <text>] [--allow-unchanged] [--json]
silksong-git history restore <commit> --to <path> [--repo <history-repo>]
silksong-git history rebuild [--repo <history-repo>] [--json]

silksong-git ui open [--repo <history-repo>]
```

The first version requires explicit group/action commands. Do not add implicit default actions before the first CLI is implemented and exercised. Restore must remain explicit.

The groups are user-facing operation objects, not internal packages.

Default command output is human-readable text. `--json` provides stable machine-readable output for scripts and tests. JSON output should directly emit the relevant public Interface result unless a command explicitly documents a different shape. Human-readable output is not a stable byte-for-byte contract.

`save decode` is the exception: it always emits Decoded Save JSON because it is a debugging command for inspecting raw decoded shape. It outputs `decodeEncodedSave(bytes).decodedSave`, not the full `DecodedEncodedSave` wrapper. It uses the public `packages/core` `decodeEncodedSave` Interface directly and does not call `parseDecodedSave` unless `--schema-check` is requested. The raw Decoded Save shape is not a stable semantic Interface.

`save decode` supports:

```txt
<save.dat>
  required positional input Encoded Save path

--out <decoded-save.json>
  optional output path; stdout is used when omitted

--compact
  print compact JSON; default output is pretty JSON for debugging

--schema-check
  also call parseDecodedSave and report whether the decoded shape is recognized
```

`watch start` starts the long-running Local History Watch Process for one Save History Repository. By default it watches the Watched Save, commits stable Raw Save Observations according to Capture Policy, updates the Semantic Read Model, reports status in terminal output, and shuts down cleanly on process termination. The default human-readable runtime log is diagnostic output and should be written to stderr; it is not a byte-stable scripting contract. `--jsonl` writes one stable machine-readable status event per line to stdout. `--http` enables the local HTTP Adapter inside that same process so the Web UI can connect to history workflows. `--port <port>` chooses the runtime local API port when HTTP is enabled; if omitted, the process requests port `0` and reports the concrete bound endpoint. The HTTP host is fixed to `127.0.0.1`. Endpoint and token are separate fields in the one started event and are not repeated later.

`watch start` supports:

```txt
--repo <history-repo>
  optional Save History Repository path; when omitted, repository context is resolved like other repository-scoped commands

--jsonl
  emit compact stable JSON Lines status events to stdout; default human-readable runtime logs go to stderr

--http
  enable the local HTTP Adapter inside this watch process

--port <port>
  optional runtime local API port; valid only when --http is used
```

P5-T5 may register `--http` and `--port` as known flags but should fail clearly when either is used, because the HTTP Adapter is implemented by P5-T7. `--port` without HTTP is invalid. `--jsonl` belongs to P5-T5.

`repo init` supports:

```txt
--save <save.dat>
  required Watched Save path; must exist, be readable, and be a file; stored in Project Config as an absolute path

--repo <history-repo>
  required target Save History Repository path; resolved to an absolute path

--json
  print InitSaveHistoryResult JSON; text output should include a brief next-step hint
```

`repo init` may create a missing target directory or initialize an existing empty target directory. A directory is empty only when it has no entries. Existing initialized repositories and non-empty uninitialized directories fail by default; the first version does not provide a force flag. `repo init` does not decode the Watched Save and does not commit an initial observation.

`history list` supports:

```txt
--limit <n>
  optional page size; must be an integer from 1 to 1000

--cursor <cursor>
  optional opaque cursor returned by an earlier list result

--include-filtered
  include Semantic Events hidden by Display Semantic Event Filters

--json
  print HistoryResult JSON
```

The first version does not expose raw-observation listing through the CLI. Raw observations remain available behind the `packages/history` Interface for future workflows.

`history diff` supports:

```txt
<from> <to>
  required commit refs to compare

--include-filtered
  include Semantic Events hidden by Display Semantic Event Filters

--json
  print DiffCommitsResult JSON
```

`history search` supports:

```txt
--event <text>
  free-text convenience search; maps to the history text query

--item-id <id>

--label <text>

--type <type>

--status-to <status>
  accepted | done | missing | unknown

--direction <direction>
  neutral | progression | regression

--include-filtered
  include Semantic Events hidden by Display Semantic Event Filters

--json
  print SearchSemanticEventsResult JSON
```

At least one query flag is required for `history search`. `--event` free-text search is a convenience for interactive use, not the stable programmatic Interface.

`history checkpoint` supports:

```txt
--message <text>
  optional checkpoint message stored in Observation Metadata; Git commit message text may include it but is not a stable Interface

--allow-unchanged
  commit a manual checkpoint even when the current Encoded Save bytes match the previous observation

--json
  print ObserveSaveResult JSON
```

Manual checkpoints bypass minimum commit interval suppression. They do not bypass decode failure, unrecognized schema handling, repository locking, or unchanged-save suppression unless `--allow-unchanged` is present.

`history rebuild` supports:

```txt
--json
  print RebuildSemanticReadModelResult JSON
```

Rebuild is allowed when there are no observation commits; it should create an empty Semantic Read Model and return zero counts.

## Repo Context Resolution

Repository-scoped commands resolve the Save History Repository in this order:

```txt
--repo <history-repo>
cwd is inside a Save History Repository
error: repository path required
```

`repo init` always requires `--repo` because the target Save History Repository may not exist yet.

When `--repo` is provided, it always wins over cwd discovery. Cwd discovery walks upward from the current working directory and selects the nearest parent containing `.silksong-git/config.json`; it must not treat an unrelated Git repository as a Save History Repository. Invalid explicit repository paths fail instead of being auto-initialized.

## CLI Safety Classes

Commands should make side effects visible in their names, arguments, and confirmation behavior:

| Safety class           | Commands                                                                         | Requirements                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only              | `save decode`, `save snapshot`, `history list`, `history diff`, `history search` | No writes to Git, SQLite, or user save files.                                                                                                      |
| Debug file write       | `save decode --out <decoded-save.json>`                                          | Writes only the explicit Decoded Save output path.                                                                                                 |
| Repository creation    | `repo init`                                                                      | Requires explicit `--save` and `--repo`.                                                                                                           |
| Raw observation write  | `history checkpoint`                                                             | Writes Git raw-observation artifacts and may update SQLite; bypasses minimum-interval suppression but not decode failure or repository locking.    |
| Read-model mutation    | `history rebuild`                                                                | May rewrite the SQLite Semantic Read Model; does not rewrite Git history.                                                                          |
| Process start          | `watch start`, `ui open`                                                         | `watch start` may start the Local History Watch Process; `ui open` may open or serve the frontend client without becoming a second history writer. |
| Filesystem write       | `history restore <commit> --to <path>`                                           | Requires an explicit Restore Target.                                                                                                               |
| High-risk save rewrite | `history restore <commit> --in-place`                                            | Requires explicit in-place intent and must create a backup before writing.                                                                         |

## CLI Error Behavior

`save decode <save.dat>` behavior:

```txt
success:
  exit 0
  print Decoded Save JSON to stdout or write it to --out

decode failure:
  exit 2
  stderr: cannot decode save
  no JSON output

--schema-check recognized:
  exit 0
  output raw Decoded Save JSON
  stderr: recognized save schema

--schema-check unrecognized:
  exit 0
  output raw Decoded Save JSON
  stderr: warning: decoded save does not match a recognized schema
```

`save snapshot <save.dat>` behavior:

```txt
success:
  exit 0
  print SemanticSnapshot JSON

decode failure:
  exit 2
  stderr: cannot decode save
  no JSON snapshot

unknown schema:
  exit 3 by default
  stderr suggests using save decode <save.dat> for raw debugging
```

History-oriented commands should report rebuild-required or stale-read-model cases clearly instead of silently returning incomplete results.

`repo init` behavior:

```txt
success:
  exit 0
  create the Save History Repository and Project Config
  text output may suggest running history checkpoint next
  --json prints InitSaveHistoryResult

invalid save path, non-empty target directory, already initialized target, or initialization failure:
  exit 1
  stderr explains the configuration error
```

`history checkpoint` behavior:

```txt
success:
  exit 0
  commit the current Watched Save as a Raw Save Observation
  mark observation.json with trigger: "manualCheckpoint"
  unrecognized schema observations still count as successful commits

unchanged save without --allow-unchanged:
  exit 0
  no Raw Save Observation is committed
  text output suggests --allow-unchanged
  --json prints ObserveSaveResult with status: "skipped" and reason: "unchanged"

decode failure:
  exit 2
  stderr: cannot decode save
  no Raw Save Observation is committed

repository busy:
  exit 4
  stderr: history repository is busy
```

`history list` behavior:

```txt
success:
  exit 0
  print Semantic Event history or HistoryResult JSON

no semantic events:
  exit 0
  text output: no semantic events found
  --json prints HistoryResult with events: []

read model unavailable:
  exit 5
  stderr suggests running history rebuild
```

`history search` behavior:

```txt
success:
  exit 0
  print matching Semantic Events or SearchSemanticEventsResult JSON

no query flags:
  exit 1
  stderr says history search requires at least one query flag

invalid --status-to or --direction value:
  exit 1
  stderr explains the invalid value

no matching semantic events:
  exit 0
  text output: no matching semantic events found
  --json prints SearchSemanticEventsResult with events: []

read model unavailable:
  exit 5
  stderr suggests running history rebuild
```

`history diff` behavior:

```txt
success:
  exit 0
  print semantic changes or DiffCommitsResult JSON

no semantic changes:
  exit 0
  text output: no semantic changes found
  --json prints DiffCommitsResult with events: []

invalid commit ref:
  exit 1
  stderr explains the invalid commit ref

semantic snapshot unavailable for one or both commits:
  exit 3
  stderr explains that semantic snapshot data is unavailable

read model unavailable:
  exit 5
  stderr suggests running history rebuild
```

`history rebuild` behavior:

```txt
success:
  exit 0
  rebuild the SQLite Semantic Read Model from Git raw observation commits
  print a text summary or RebuildSemanticReadModelResult JSON

repository busy:
  exit 4
  stderr: history repository is busy
```

`history restore <commit> --to <path>` behavior:

```txt
success:
  exit 0
  write the commit's Encoded Save to the explicit Restore Target
  print a text summary

missing restore target mode:
  exit 1
  stderr explains that exactly one of --to or --in-place is required

--to and --in-place both present:
  exit 1
  stderr explains that exactly one of --to or --in-place is required

--in-place without --confirm-in-place:
  exit 1
  stderr explains that in-place restore requires --confirm-in-place

--confirm-in-place without --in-place:
  exit 1
  stderr explains that --confirm-in-place requires --in-place

invalid commit ref:
  exit 1
  stderr explains the invalid commit ref

target path already exists:
  exit 1
  stderr explains that the restore target already exists
  no file is overwritten
```

## Restore Safety

Restore defaults to an explicit Restore Target:

```txt
silksong-git history restore <commit> --to <path> [--repo <history-repo>]
```

Overwriting the Watched Save requires explicit in-place restore:

```txt
silksong-git history restore <commit> --in-place --confirm-in-place [--repo <history-repo>]
```

In-place restore must:

- Read the Watched Save path from Project Config.
- Require `--in-place` and `--confirm-in-place`.
- Be mutually exclusive with `--to`.
- Create a backup before overwriting an existing Watched Save.
- Allow restore without a backup when the Watched Save does not exist.
- Keep restore itself from creating a Raw Save Observation; a running watcher or later manual checkpoint records the resulting file state through the normal observation flow.
- Hold the Save History Repository write lock for the full restore flow.
- Read back the written file and verify its hash before reporting success.

Configured backup directories must be absolute paths. If `restore.backupDirectory` is not configured, backups are written beside the Watched Save. If a backup directory exists but is not a directory, cannot be created, or is relative, in-place restore fails before writing the Watched Save.

Backup files contain the original Watched Save bytes exactly as they existed before restore. They are not decoded or validated. Backup names use:

```txt
<original-basename>.before-restore.<timestamp>.dat
```

If that file already exists, append `.1` through `.9` before `.dat` and fail without overwriting the Watched Save if all candidates already exist.

If backup succeeds but writing or verification fails, the backup is preserved and the error should expose the backup path. Restore does not attempt automatic rollback.

The local Web UI should default to export/download behavior, not silent in-place overwrite.

## Web UI Modes

One Web UI runs in two modes:

```txt
Static Web Mode
  browser-only
  user uploads an Encoded Save or Decoded Save JSON
  shows Progress, Map, and Raw Save Data
  no Git, SQLite, filesystem, or local API

Local History Web Mode
  enabled by connecting to a compatible local HTTP endpoint
  uses local HTTP Adapter over packages/history
  defaults Progress, Map, and Raw Save Data to latest Save State
  can fix those views to one historical observation commit
  adds History, Diff, and Watcher workflows
```

The Web UI's mode is determined by a successful authenticated compatibility handshake, not by the mechanism that serves the frontend. During implementation and debugging the frontend can run through Vite; future releases may serve it statically or through a small frontend-serving process. Static and Local modes do not retain competing save states: successful connection clears the uploaded Static Save, and disconnect returns to an empty Static Web Mode. Manual connection uses a Topbar dialog, not a separate backend view. Endpoint and token live only in page memory and never in browser storage or the URL.

First-version views:

```txt
Progress / Map / Raw Save Data
  existing tracker functionality
  latest by default in Local History Web Mode
  canonical commit selected through a shared commit URL query
  historical Topbar banner with Back to Latest

History
  Events and Observations views with recent-first Load More pagination
  Events grouped by commit and expanded by default
  unfiltered History and submitted structured Search share one list UI
  search fields and pending compare source are represented in the URL
  commit headers show Completion, Play Time, Rosaries, and Shell Shards
  commit actions include Progress selection, Export, Restore, and Compare

Diff
  from/to canonical refs represented in the URL
  Progress-style Semantic Diff defaults to changes and can show unchanged items
  lazy Monaco comparison of the two Decoded Save JSON values

Watcher
  watched path, activity, last observation, errors, and capture policy
  Manual Checkpoint action
```

History search uses `/history` when no fields are submitted and `/search` when at least one field is present; merging the UI does not merge the two history Module Interfaces. The first search form exposes free text, event kind, target status, direction, and `includeFiltered`. Filtered events retain server-provided visibility reasons. Submitted filters are represented in the URL, while opaque cursors remain runtime state. Load More appends older results and merges commit groups that cross cursor pages.

Selecting any History commit, including the commit that happens to be latest at selection time, fixes Progress, Map, and Raw Save Data to its canonical ref. Watcher polling refreshes a moving latest selection but never replaces a historical selection. A stable second-row Topbar banner shows the selected ref and time, reports when a newer latest exists, and contains Back to Latest. The existing save-mode banner and the historical banner use the established visual language without infinite blinking animation.

History embeds Export and Restore rather than adding separate views. Export downloads authenticated Encoded Save bytes with the server-provided safe filename and does not change route or selection. Restore opens a non-retrying confirmation flow, uses latest observation state as its normal precondition, and reports watcher desynchronization as a conflict. The explicit missing-file path is separate and warns that no original-file backup exists. Restore success does not navigate automatically; watcher observation and user navigation remain explicit.

Semantic Diff renders through a Progress-style Module that accepts explicit Snapshot and comparison data instead of mutating the application Save Store. It uses the `to` Snapshot for the main item appearance, highlights events returned by `diffCommits`, defaults to changed items, and offers Show unchanged. It does not duplicate the changes in a second linear event list. If either Snapshot is unavailable because its observation schema is unrecognized, Semantic Diff reports that state and selects the still-available Decoded Save JSON diff.

Local History credentials and connection state remain in memory across hash-route navigation but are lost on reload. A Local History URL opened without a connection is preserved behind a connection-required state so reconnection can resume it. The Sidebar shows History, Diff, and Watcher only while connected. Watcher polling runs while the page is visible, reacts only to revision changes, and merges new persistent results without disrupting History scroll position. Authentication or protocol failure pauses automatic requests and preserves loaded data as stale until reconnect or explicit disconnect.

## Accepted ADRs

The current accepted decisions are:

- ADR-0001: Store raw save observations in Git and semantic history in SQLite.
- ADR-0002: Model semantic events as item-level state transitions.
- ADR-0003: Cover Web UI items and save summary metrics in semantic snapshots.
- ADR-0004: Resolve config from built-in defaults, project config, and CLI args.
- ADR-0005: Use one save history repository per watched save.
- ADR-0006: Use a small raw-observation repository layout.
- ADR-0007: Require an explicit restore target unless in-place restore is requested.
- ADR-0008: Use one local process for watching and the local history API.
- ADR-0009: Use one Web UI with static and local history modes.
- ADR-0010: Keep the first CLI command set small and lifecycle-oriented.
- ADR-0011: Split the fork into core, history, CLI, and Web workspace packages.
- ADR-0012: Expose a small semantic core interface.
- ADR-0013: Expose a small history module interface and test it through behavior.
- ADR-0014: Generate numeric semantic events from meaningful state transitions.
- ADR-0015: Record version stamps for decoding and semantic mapping.
- ADR-0016: Commit decoded observations even when the save schema is unrecognized.
- ADR-0017: Start implementation with a core semantic tracer bullet.
- ADR-0018: Serve a secure versioned local HTTP Adapter from the watch process.

## Open Design Questions

These are intentionally left for later design or implementation:

- Exact TypeScript shapes for `SemanticSnapshot`, `SemanticEvent`, `MappingData`, and config.
- Exact SQLite schema and migration strategy inside `packages/history`.
- Exact Web UX for transferring the reported endpoint/token into a browser session.
- Exact frontend serving strategy outside development.
- Whether a later version needs streaming watcher status or durable watcher diagnostics beyond first-version polling.
- Exact text output formatting for CLI commands.
- Whether and how to support multi-save workspaces after the first version.
