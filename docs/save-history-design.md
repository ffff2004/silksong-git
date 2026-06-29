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
- Creating a local Git-backed Save History Repository for that Watched Save.
- Committing stable Raw Save Observations so future semantic mapping changes can rebuild history.
- Building a SQLite Semantic Read Model from Git history.
- Viewing Semantic Events, semantic diffs, history, reverse event lookup, and restore/export workflows from CLI and local Web UI.
- Preserving the existing static Web UI upload workflow for current-save inspection.
- Sharing one semantic core between CLI, local Web UI, static Web UI, and tests.

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
  start Local History Process

apps/cli
  parse CLI args
  call packages/core and packages/history
  render text or JSON output

apps/web
  existing Vite Web UI
  Static Web Mode for upload-only current-save inspection
  Local History Web Mode through local HTTP endpoints
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
```

`save.dat`, `decoded-save.json`, `observation.json`, and `.silksong-git/config.json` are committed. `read-model.sqlite` is ignored by Git because it is rebuildable.

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

Decode failure is a Watcher Error and must not be committed. It usually means a half-written file, corrupted input, wrong path, or non-save file.

Decode success with unknown save shape becomes an Unrecognized Schema Observation. It is committed with `save.dat`, `decoded-save.json`, and `observation.json`, but does not produce Semantic Snapshots or Semantic Events until a future rebuild supports that Save Schema Version.

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
CLI args > Project Config > User Config > built-in defaults
```

Recommended locations:

```txt
User Config:
  ~/.config/silksong-git/config.json

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
  localUi: {
    host: "127.0.0.1";
    port?: number;
  };
}
```

## Core Module Interface

`packages/core` should expose a small deep Module interface:

```ts
decodeEncodedSave(bytes: ArrayBuffer | Uint8Array): unknown;

parseDecodedSave(input: unknown): DecodedSave;

getBuiltinMappingData(): MappingData;

createSemanticSnapshot(
  decodedSave: DecodedSave,
  mappingData: MappingData,
  options?: SnapshotOptions,
): SemanticSnapshot;

diffSemanticSnapshots(
  before: SemanticSnapshot,
  after: SemanticSnapshot,
  options?: DiffOptions,
): SemanticEvent[];
```

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
initSaveHistory(input): InitResult;

observeSave(repoPath, options?): ObservationResult;

rebuildSemanticReadModel(repoPath, options?): RebuildResult;

queryHistory(repoPath, query): HistoryResult;

diffCommits(repoPath, fromRef, toRef, options?): SemanticEvent[];

searchSemanticEvents(repoPath, query): SearchResult;

restoreEncodedSave(repoPath, commitRef, target): RestoreResult;

startLocalHistoryProcess(repoPath, options): LocalHistoryProcess;
```

Git, SQLite, file watching, config loading, and local HTTP are implementation details or internal Adapters behind this Interface.

The SQLite schema is not public. CLI and Web callers must use `queryHistory`, `diffCommits`, and `searchSemanticEvents`; they must not query tables directly.

## Local History Process

One Local History Process owns:

```txt
watching the Watched Save
committing Raw Save Observations
updating SQLite Semantic Read Model
serving local Web UI
serving local HTTP endpoints
```

No second process should independently watch the same save and write Git or SQLite.

Local HTTP endpoints are thin Adapters over `packages/history`. They should call history functions and should not directly query SQLite or run Git operations.

CLI history/diff/search/restore commands can also run as Offline Commands that read the Save History Repository and Semantic Read Model directly through `packages/history`.

## CLI Command Set

ADR-0010 decides that the first CLI is object-grouped and lifecycle-oriented. The command grammar below is the implementation map for that decision.

First-version commands:

| Group     | Action     | User-facing object        | Responsibility                                                    |
| --------- | ---------- | ------------------------- | ----------------------------------------------------------------- |
| `repo`    | `init`     | Save History Repository   | Create a single-save Save History Repository and Project Config.  |
| `save`    | `decode`   | Encoded Save              | Decode one save to raw Decoded Save JSON for debugging.           |
| `save`    | `snapshot` | Encoded Save              | Decode and map one save without writing Git history.              |
| `watch`   | `start`    | Local History Process     | Start watching the Watched Save and updating history.             |
| `history` | `list`     | Semantic Events           | Show Semantic Event history and optionally raw observations.      |
| `history` | `diff`     | Semantic Snapshots/Events | Compare two commits through Semantic Snapshots.                   |
| `history` | `search`   | Semantic Events           | Find events and corresponding commits.                            |
| `history` | `restore`  | Encoded Save restore      | Write a commit's `save.dat` to an explicit Restore Target.        |
| `history` | `rebuild`  | Semantic Read Model       | Rebuild the SQLite Semantic Read Model from Git raw observations. |
| `ui`      | `open`     | Local History Web Mode    | Start or connect to the local Web UI.                             |

First-version command forms:

```txt
silksong-git repo init --save <save.dat> --repo <history-repo>

silksong-git save decode --save <save.dat> [--out <decoded-save.json>] [--compact] [--schema-check]
silksong-git save snapshot --save <save.dat> --json

silksong-git watch start [--repo <history-repo>]

silksong-git history list [--repo <history-repo>]
silksong-git history diff <from> <to> [--repo <history-repo>]
silksong-git history search [--repo <history-repo>] --event <text>
silksong-git history restore <commit> --to <path> [--repo <history-repo>]
silksong-git history rebuild [--repo <history-repo>]

silksong-git ui open [--repo <history-repo>]
```

The first version requires explicit group/action commands. Do not add implicit default actions before the first CLI is implemented and exercised. Restore must remain explicit.

The groups are user-facing operation objects, not internal packages. Avoid CLI groups such as `core`, `read-model`, or `process` even when those names match implementation Modules.

Default command output is human-readable text. `--json` provides stable machine-readable output for scripts and tests.

`save decode` is the exception: it always emits Decoded Save JSON because it is a debugging command for inspecting raw decoded shape. It uses the public `packages/core` `decodeEncodedSave` Interface directly and does not call `parseDecodedSave` unless `--schema-check` is requested. The raw Decoded Save shape is not a stable semantic Interface.

`save decode` supports:

```txt
--save <save.dat>
  required input Encoded Save path

--out <decoded-save.json>
  optional output path; stdout is used when omitted

--compact
  print compact JSON; default output is pretty JSON for debugging

--schema-check
  also call parseDecodedSave and report whether the decoded shape is recognized
```

`search` should support structured query flags such as:

```txt
--item-id
--label
--type
--status-to
```

`--event` free-text search is a convenience for interactive use, not the stable programmatic Interface.

## Repo Context Resolution

Repository-scoped commands resolve the Save History Repository in this order:

```txt
--repo <history-repo>
cwd is inside a Save History Repository
error: repository path required
```

`repo init` always requires `--repo` because the target Save History Repository may not exist yet.

## CLI Safety Classes

Commands should make side effects visible in their names, arguments, and confirmation behavior:

| Safety class           | Commands                                                                         | Requirements                                                               |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Read-only              | `save decode`, `save snapshot`, `history list`, `history diff`, `history search` | No writes to Git, SQLite, or user save files.                              |
| Debug file write       | `save decode --out <decoded-save.json>`                                          | Writes only the explicit Decoded Save output path.                         |
| Repository creation    | `repo init`                                                                      | Requires explicit `--save` and `--repo`.                                   |
| Read-model mutation    | `history rebuild`                                                                | May rewrite the SQLite Semantic Read Model; does not rewrite Git history.  |
| Process start          | `watch start`, `ui open`                                                         | May start the Local History Process or local Web UI.                       |
| Filesystem write       | `history restore <commit> --to <path>`                                           | Requires an explicit Restore Target.                                       |
| High-risk save rewrite | `history restore <commit> --in-place`                                            | Requires explicit in-place intent and must create a backup before writing. |

## CLI Error Behavior

`save decode --save` behavior:

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

`save snapshot --save` behavior:

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
  stderr suggests using save decode --save <save.dat> for raw debugging
```

History-oriented commands should report rebuild-required or stale-read-model cases clearly instead of silently returning incomplete results.

## Restore Safety

Restore defaults to an explicit Restore Target:

```txt
silksong-git history restore <commit> --to <path> [--repo <history-repo>]
```

Overwriting the Watched Save requires explicit in-place restore:

```txt
silksong-git history restore <commit> --in-place [--repo <history-repo>]
```

In-place restore must:

- Read the Watched Save path from Project Config.
- Require explicit user intent.
- Create a backup before writing.

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
  served by Local History Process
  uses local HTTP Adapter over packages/history
  shows Current Save plus history workflows
```

First-version views:

```txt
Current Save
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

Implementation should start in `packages/core`:

```txt
core tracer:
  decoded save fixture + mapping fixture
  -> createSemanticSnapshot()
  -> SemanticSnapshot contains a scene-scoped collected item
```

Then proceed:

```txt
core diff:
  two Semantic Snapshots
  -> diffSemanticSnapshots()
  -> item-level Semantic Event

history raw observation:
  initSaveHistory()
  observeSave()
  restoreEncodedSave()
  -> restored bytes equal original save bytes

history semantic index:
  two raw observation commits
  rebuildSemanticReadModel()
  diffCommits()/searchSemanticEvents()
  -> event maps to expected commit

CLI snapshot:
  save decode --save fixture
  -> Decoded Save JSON

  save snapshot --save fixture --json
  -> SemanticSnapshot JSON

Web current save:
  existing upload flow calls packages/core
  -> same tracker state as before
```

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
- ADR-0004: Resolve config from built-in defaults, user config, project config, and CLI args.
- ADR-0005: Use one save history repository per watched save.
- ADR-0006: Use a small raw-observation repository layout.
- ADR-0007: Require an explicit restore target unless in-place restore is requested.
- ADR-0008: Use one local process for watching and the local Web UI.
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
- Exact text output formatting for CLI commands.
- Whether and how to support multi-save workspaces after the first version.
