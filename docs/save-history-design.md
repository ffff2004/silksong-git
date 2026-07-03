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
  start Local History API Process

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
file changed
  -> wait for debounce/stability
  -> read bytes
  -> decode Encoded Save
  -> identify/parse Decoded Save
  -> apply Capture Policy
  -> commit Raw Save Observation
  -> update Semantic Read Model when semantic mapping is possible
```

A manual checkpoint uses the same decode, classify, commit, and read-model update behavior, but is triggered by the user instead of the file watcher. It does not wait for watcher debounce and bypasses the minimum commit interval. Committing unchanged bytes still requires explicit user intent.

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

If multiple stable save changes occur inside `minCommitIntervalMs`, only the latest Raw Save Observation is committed. This is an explicit fidelity trade-off: the user gets fewer commits but loses intermediate raw states.

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
  localApi: {
    host: "127.0.0.1";
  };
}
```

`localApi.host` is persisted because it is a security-relevant binding constraint. The local API port is a runtime binding, not a Project Config field; it may be assigned dynamically or provided through a process-start override such as a CLI flag, and the running process should report the concrete endpoint it bound to. The port only applies when the Local History API Process starts its optional HTTP Adapter.

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

diffCommits(input: DiffCommitsInput): Promise<DiffCommitsResult>;

searchSemanticEvents(
  input: SearchSemanticEventsInput,
): Promise<SearchSemanticEventsResult>;

restoreEncodedSave(
  input: RestoreEncodedSaveInput,
): Promise<RestoreEncodedSaveResult>;

startLocalHistoryApiProcess(
  input: StartLocalHistoryApiProcessInput,
): Promise<LocalHistoryApiProcess>;

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
  force?: boolean;
}

type ObserveSaveResult =
  | {
      status: "committed";
      observation: RawSaveObservation;
      semanticUpdate: SemanticUpdateResult;
    }
  | {
      status: "skipped";
      reason: "unchanged" | "minimumCommitInterval";
      encodedSha256: string;
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
  includeRawObservations?: boolean;
  limit?: number;
  cursor?: string;
}

interface HistoryResult {
  events: readonly HistoricalSemanticEvent[];
  rawObservations?: readonly RawSaveObservation[];
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
}

interface SearchSemanticEventsResult {
  events: readonly HistoricalSemanticEvent[];
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
```

Git, SQLite, file watching, config loading, and local HTTP are implementation details or internal Adapters behind this Interface.

`queryHistory`, `diffCommits`, and `searchSemanticEvents` should return Semantic Events with their commit and Raw Save Observation metadata. CLI and Web callers should not need separate Git or SQLite lookups to explain where an event came from.

Display Semantic Event Filters apply consistently to `queryHistory`, `diffCommits`, and `searchSemanticEvents`. Default calls return default-visible events; `includeFiltered: true` returns hidden events as well, with `visibility.filterReasons` explaining why they are hidden by default.

The SQLite schema is not public. CLI and Web callers must use `queryHistory`, `diffCommits`, and `searchSemanticEvents`; they must not query tables directly. Git command details are not public either; restore and history lookup go through `packages/history`.

`searchSemanticEvents` accepts structured query fields as its stable Interface. Free-text `text` search supports the CLI `--event` convenience, but Web and programmatic callers should prefer structured fields.

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

## Local History API Process

One Local History API Process owns:

```txt
watching the Watched Save
committing Raw Save Observations
updating SQLite Semantic Read Model
serving local HTTP endpoints when the HTTP Adapter is enabled
```

No second process should independently watch the same save and write Git or SQLite.

All history writers must acquire one Save History Repository write lock before mutating Git artifacts or SQLite. This includes watcher observations and manual checkpoints.

Local HTTP endpoints are thin Adapters over `packages/history`. They should call history functions and should not directly query SQLite or run Git operations. In the first version, `watch start` does not expose HTTP by default; `watch start --http` enables the HTTP Adapter inside the same Local History API Process. Enabling HTTP must not create a second history writer.

The Web UI frontend is a client of these endpoints. Serving the frontend is not part of the single-writer invariant: implementation and debugging can use Vite, and a later release can add static hosting or a small frontend-serving process without changing the Local History API Process contract.

CLI history/diff/search/restore commands can also run as Offline Commands that read the Save History Repository and Semantic Read Model directly through `packages/history`.

## CLI Command Set

ADR-0010 decides that the first CLI is object-grouped and lifecycle-oriented. The command grammar below is the implementation map for that decision.

First-version commands:

| Group     | Action       | User-facing object        | Responsibility                                                                                  |
| --------- | ------------ | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `repo`    | `init`       | Save History Repository   | Create a single-save Save History Repository and Project Config.                                |
| `save`    | `decode`     | Encoded Save              | Decode one save to raw Decoded Save JSON for debugging.                                         |
| `save`    | `snapshot`   | Encoded Save              | Decode and map one save without writing Git history.                                            |
| `watch`   | `start`      | Local History API Process | Start watching the Watched Save, updating history, and optionally serving local HTTP endpoints. |
| `history` | `list`       | Semantic Events           | Show Semantic Event history.                                                                    |
| `history` | `diff`       | Semantic Snapshots/Events | Compare two commits through Semantic Snapshots.                                                 |
| `history` | `search`     | Semantic Events           | Find events and corresponding commits.                                                          |
| `history` | `checkpoint` | Raw Save Observation      | Commit the current Watched Save as a manual checkpoint.                                         |
| `history` | `restore`    | Encoded Save restore      | Write a commit's `save.dat` to an explicit Restore Target.                                      |
| `history` | `rebuild`    | Semantic Read Model       | Rebuild the SQLite Semantic Read Model from Git raw observations.                               |
| `ui`      | `open`       | Web UI client             | Open the Web UI client and connect it to a local endpoint when available.                       |

First-version command forms:

```txt
silksong-git repo init --save <save.dat> --repo <history-repo> [--json]

silksong-git save decode <save.dat> [--out <decoded-save.json>] [--compact] [--schema-check]
silksong-git save snapshot <save.dat> --json

silksong-git watch start [--repo <history-repo>] [--http] [--port <port>]

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

`watch start` starts the long-running Local History API Process for one Save History Repository. By default it watches the Watched Save, commits stable Raw Save Observations according to Capture Policy, updates the Semantic Read Model, reports status in terminal output, and shuts down cleanly on process termination. `--http` enables the local HTTP Adapter inside that same process so the Web UI can connect to history workflows. `--port <port>` chooses the runtime local API port when HTTP is enabled; if omitted, the process may choose an available port and must report the concrete endpoint. The HTTP host comes from Project Config `localApi.host`.

`watch start` supports:

```txt
--repo <history-repo>
  optional Save History Repository path; when omitted, repository context is resolved like other repository-scoped commands

--http
  enable the local HTTP Adapter inside this watch process

--port <port>
  optional runtime local API port; valid only when --http is used
```

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

| Safety class           | Commands                                                                         | Requirements                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read-only              | `save decode`, `save snapshot`, `history list`, `history diff`, `history search` | No writes to Git, SQLite, or user save files.                                                                                                    |
| Debug file write       | `save decode --out <decoded-save.json>`                                          | Writes only the explicit Decoded Save output path.                                                                                               |
| Repository creation    | `repo init`                                                                      | Requires explicit `--save` and `--repo`.                                                                                                         |
| Raw observation write  | `history checkpoint`                                                             | Writes Git raw-observation artifacts and may update SQLite; bypasses minimum-interval suppression but not decode failure or repository locking.  |
| Read-model mutation    | `history rebuild`                                                                | May rewrite the SQLite Semantic Read Model; does not rewrite Git history.                                                                        |
| Process start          | `watch start`, `ui open`                                                         | `watch start` may start the Local History API Process; `ui open` may open or serve the frontend client without becoming a second history writer. |
| Filesystem write       | `history restore <commit> --to <path>`                                           | Requires an explicit Restore Target.                                                                                                             |
| High-risk save rewrite | `history restore <commit> --in-place`                                            | Requires explicit in-place intent and must create a backup before writing.                                                                       |

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
  user uploads save.dat or raw JSON
  shows Current Save views
  no Git, SQLite, filesystem, or local API

Local History Web Mode
  enabled by connecting to a compatible local HTTP endpoint
  uses local HTTP Adapter over packages/history
  shows Current Save plus history workflows
```

The Web UI's mode is determined by endpoint availability and compatibility, not by the mechanism that serves the frontend. During implementation and debugging the frontend can run through Vite; future releases may serve it statically or through a small frontend-serving process.

First-version views:

```txt
(Current Save ...)
  existing tracker/progress/raw/map functionality

History
  Semantic Event timeline and Raw Save Observations

Diff
  choose two commits and view item-level Semantic Events

Search
  structured search over events and commits

Watcher
  watched path, last observation, errors, capture policy

Restore/Export
  explicit target restore and safe export flows
```

Static Web Mode exposes only Current Save behavior. Local History Web Mode exposes History, Diff, Search, Watcher, and Restore/Export.

## TDD Strategy

Use vertical slices, not horizontal batches. One behavior test should go red, then implementation should make it green, then move to the next behavior.

Tests should verify behavior through public Interfaces:

- `packages/core` tests use `createSemanticSnapshot` and `diffSemanticSnapshots`.
- `packages/history` tests use the history Interface with temporary directories, real Git, and real SQLite.
- Mocks are limited to true system boundaries such as time and watcher event delivery.
- Tests should not assert internal helper calls, Git command calls, or SQLite table layout.

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

## Open Design Questions

These are intentionally left for later design or implementation:

- Exact TypeScript shapes for `SemanticSnapshot`, `SemanticEvent`, `MappingData`, and config.
- Exact SQLite schema and migration strategy inside `packages/history`.
- Exact local HTTP route names and payloads.
- Exact local HTTP endpoint discovery, capability/version negotiation, and connection UX.
- Exact frontend serving strategy outside development.
- Whether watcher status uses polling first or a later streaming mechanism such as SSE/WebSocket.
- Exact text output formatting for CLI commands.
- Whether and how to support multi-save workspaces after the first version.
