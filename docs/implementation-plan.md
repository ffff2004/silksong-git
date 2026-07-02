# Implementation Plan

This document is the execution tracker for the save-history fork. It records phase order, task dependencies, current progress, acceptance criteria, and verification results so future agents can continue without chat history.

For architecture and rationale, read `docs/save-history-design.md`, `CONTEXT.md`, and the relevant ADRs. This document should not repeat their design detail.

## Current Status

- Current phase: P5 CLI
- Next task: P5-T4 Implement In-Place History Restore
- Last updated: 2026-07-02

## Phase Overview

| Phase                                 | Status      | Depends On | Goal                                                                                                 |
| ------------------------------------- | ----------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| P1 Documentation / Repository Hygiene | complete    | none       | Documentation is coherent, old references are moved, and validation passes.                          |
| P2 Workspace Skeleton                 | complete    | P1         | pnpm workspace exists while existing Web behavior remains unchanged.                                 |
| P3 Core Semantic Module               | complete    | P2         | `packages/core` exposes decode, parse, snapshot, and diff behavior through a small public Interface. |
| P4 History Module                     | complete    | P3         | Raw observations, restore, and SQLite Semantic Read Model work through `packages/history`.           |
| P5 CLI                                | in progress | P3, P4     | First object-grouped CLI command set works through core/history Interfaces.                          |
| P6 Web Integration                    | in progress | P3, P4     | Web UI uses core and supports static and local history modes.                                        |

## Task Rules

Each task should include:

- Goal
- Dependencies
- Owned files or likely files
- Relevant docs and ADRs
- Acceptance criteria
- Verification commands and results

When a task is completed, update its status and verification result in this document. Do not rely on chat history for progress tracking.

Status values:

```txt
pending
in progress
blocked
complete
```

## Updating This Plan

When adding a task:

- Add it under the matching phase.
- Include status, dependencies, owned files, relevant docs and ADRs, acceptance criteria, and verification.
- Update `## Current Status` if it becomes the next task.
- Update `## Phase Overview` if phase scope, order, dependencies, or status changes.
- Add or update ADRs only when the task records a durable design decision.

When completing a task:

- Set the task status to `complete`.
- Replace pending verification entries with actual commands and results.
- Add notes for completed facts, deviations, or known follow-up.
- Update `## Current Status`.
- Update `## Phase Overview` if a phase status changes.

Use other authoritative docs for non-progress changes:

- `docs/save-history-design.md`: future architecture or implementation guidance.
- `CONTEXT.md`: settled or renamed domain terms.
- `docs/adr/`: durable design decisions.
- `docs/current-design-reference/`: current Web behavior clarifications only.
- `AGENTS.md`: agent workflow rules.

## P1 Documentation / Repository Hygiene

### P1-T1 Finalize Agent And Design Documentation

Status: complete

Depends on:

- none

Owned files:

- `AGENTS.md`
- `CONTEXT.md`
- `docs/save-history-design.md`
- `docs/implementation-plan.md`
- `docs/adr/*.md`
- `docs/current-design-reference/*.md`

Relevant docs and ADRs:

- `docs/save-history-design.md`
- ADR-0001 through ADR-0017

Acceptance criteria:

- `AGENTS.md` points agents to the correct authoritative docs and avoids duplicating architecture details.
- `docs/implementation-plan.md` records phases, dependencies, task rules, and initial backlog.
- Current-system docs are under `docs/current-design-reference/`.
- `docs/current-design-reference/save-to-semantic.md` is English and passes the illegal-character check.
- `pnpm format` passes.
- `pnpm lint` passes.

Verification:

- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- `AGENTS.md` has been rewritten as an agent/maintainer entry point.
- `CONTEXT.md`, `docs/save-history-design.md`, and ADR-0001 through ADR-0017 exist.
- Current-system reference docs live under `docs/current-design-reference/`.
- `docs/current-design-reference/save-to-semantic.md` is English and ASCII-only.
- `scripts/decode-save.ts` was removed by the user after causing unrelated lint failures.

## P2 Workspace Skeleton

### P2-T1 Create Workspace Layout Without Behavior Change

Status: complete

Depends on:

- P1-T1

Owned files or likely files:

- `package.json`
- workspace config file, if needed
- `apps/web/`
- `packages/core/`
- `packages/history/`
- `apps/cli/`
- Vite and TypeScript configs as needed

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0011](adr/0011-workspace-package-architecture.md)

Acceptance criteria:

- Workspace directories exist.
- Existing Web UI still builds and starts with equivalent behavior.
- No semantic mapping behavior changes.
- Validation passes.

Verification:

- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm build`: passed
- `pnpm start -- --host 127.0.0.1`: started Vite at the then-current base path; stopped with SIGINT after verification.

Notes:

- Added `pnpm-workspace.yaml` with `apps/*` and `packages/*`.
- Added package manifests for `apps/web`, `apps/cli`, `packages/core`, and `packages/history`.
- Moved the existing Vite Web app into `apps/web` without changing semantic mapping code.
- Kept root scripts as repository-level entry points that delegate Web build/start/preview to `@silksong-git/web`.
- Replaced the npm lock with `pnpm-lock.yaml`.

## P3 Core Semantic Module

### P3-T1 Core Snapshot Tracer Bullet

Status: complete

Depends on:

- P2-T1

Owned files or likely files:

- `packages/core/`
- test fixtures under `packages/core/`
- mapping data imports or copies as needed

Relevant docs and ADRs:

- `docs/save-history-design.md`
- `docs/current-design-reference/save-to-semantic.md`
- [ADR-0012](adr/0012-core-semantic-module-interface.md)
- [ADR-0017](adr/0017-start-implementation-with-core-tracer-bullet.md)

Acceptance criteria:

- A decoded save fixture plus mapping fixture produces a Semantic Snapshot through the public core Interface.
- The first covered behavior is a scene-scoped collected item.
- Tests verify behavior through `createSemanticSnapshot`, not internal helpers.

Verification:

- `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- Added the first public `packages/core` slice through `createSemanticSnapshot`.
- The tracer bullet uses a decoded save fixture and mapping fixture to mark scene-scoped `Heart Piece` in `Crawl_02` as `done`.
- The first snapshot output includes item source references, summary metrics, and mapping/core version fields.
- Only the `sceneBool` path is implemented so far; later item types remain future vertical slices.

### P3-T2 Core Snapshot Current Mapping Coverage

Status: complete

Depends on:

- P3-T1

Owned files or likely files:

- `packages/core/`
- core snapshot tests and fixtures
- mapping data imports or copies from `apps/web/src/data/*.json`

Relevant docs and ADRs:

- [ADR-0003](adr/0003-semantic-snapshot-coverage.md)
- [ADR-0012](adr/0012-core-semantic-module-interface.md)
- [ADR-0015](adr/0015-version-stamps-for-decoding-and-semantic-mapping.md)
- [ADR-0017](adr/0017-start-implementation-with-core-tracer-bullet.md)
- `docs/current-design-reference/save-to-semantic.md`

Acceptance criteria:

- `createSemanticSnapshot` covers the current Web semantic mapping behavior documented in `docs/current-design-reference/save-to-semantic.md`.
- Coverage includes `sceneBool` missing behavior, `flag`, `boss`, `key`, `level`, `flagInt`, `collectable`, `tool`, `quest`, `journal`, `relic`, `materium`, `device`, `sceneVisited`, `quill`, `anyOf`, and the special scene numeric branch used by Shell Fossil Mimic-style entries.
- `getBuiltinMappingData` loads or exposes the current Web mapping tables: `main`, `essentials`, `bosses`, `mini-bosses`, `completion`, `wishes`, `journal`, and `scenes`.
- Tests verify behavior through `createSemanticSnapshot` and `getBuiltinMappingData`, not internal helpers such as scene flag scanning, item value lookup, or status normalization.
- Web presentation concerns such as DOM rendering, CSS classes, spoiler display, missing filters, map pin rendering, toasts, and browser global state stay outside `packages/core`.
- TDD proceeds in vertical slices. Add one behavior test at a time through public Interfaces, then implement only enough code to make that slice pass.

TDD Vertical Slices:

- [x] P3-T1 tracer bullet: `sceneBool` collected item is marked `done`.
- [x] `sceneBool` missing item is marked `missing`.
- [x] Direct `playerData` booleans map to semantic item status.
- [x] Key flags map to semantic item status.
- [x] Numeric thresholds map to semantic item status.
- [x] `savedData` quantity and unlocked entries map to semantic item status.
- [x] Quest states map to semantic item status.
- [x] Journal progress maps to semantic item status.
- [x] Relic, materium, and device states map to semantic item status.
- [x] `sceneVisited` entries map to semantic item status.
- [x] `quill` entries map to semantic item status.
- [x] `anyOf` entries map to semantic item status.
- [x] Special scene numeric branch supports Shell Fossil Mimic-style entries.
- [x] Built-in mapping data smoke coverage verifies `getBuiltinMappingData`.

Latest slice verification:

- Built-in mapping data smoke coverage: `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Review follow-ups:

- `decodeEncodedSave` returns `DecodedEncodedSave`, including `version.decoderVersion`, so P4 history code can write decoder provenance into Raw Save Observation metadata.
- `parseDecodedSave` returns `ParsedDecodedSave`, including the recognized `version.saveSchemaVersion`, so P4 history code should not infer Decoded Save schema itself.
- Semantic Snapshot Version Stamps include `saveSchemaVersion`, `gameVersion`, `platform`, `platformBuildId`, `mappingDataVersion`, `semanticCoreVersion`, and `configHash`.
- Save Summary Metrics use semantic names in `packages/core`: raw `geo` maps to `rosaries`, and raw `ShellShards` maps to `shellShards`.

Verification:

- `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- `createSemanticSnapshot` now covers every current Web mapping item type listed in the acceptance criteria.
- `getBuiltinMappingData` exposes copied current Web mapping tables from `packages/core/src/data/`.
- Tests cover behavior through public `packages/core` exports.

### P3-T3 Core Encoded Save Decode And Parse

Status: complete

Depends on:

- P3-T2

Owned files or likely files:

- `packages/core/`
- encoded save decoder/parser tests and fixtures

Relevant docs and ADRs:

- [ADR-0015](adr/0015-version-stamps-for-decoding-and-semantic-mapping.md)
- [ADR-0012](adr/0012-core-semantic-module-interface.md)
- [ADR-0016](adr/0016-commit-unrecognized-schema-observations.md)
- `docs/current-design-reference/overview.md`
- `docs/current-design-reference/save-to-semantic.md`

Acceptance criteria:

- `packages/core` exports `decodeEncodedSave` for encoded `.dat` save bytes.
- `packages/core` exports `parseDecodedSave` for validating decoded save objects as `DecodedSave`.
- The core decoder and parser match the current Web implementation's decoded output and schema expectations.
- Tests cover decoding through the public core Interface using an encoded fixture; if a real save cannot be committed, use a minimal encrypted fixture generated from the same codec.
- Tests cover JSON-upload style parsing by calling `parseDecodedSave` without `decodeEncodedSave`.
- Decode failures remain distinct from successfully decoded but unrecognized save shapes.
- `apps/web` behavior is not changed in this task; routing Web through the core decoder/parser remains P6-T1 work.

TDD Vertical Slices:

- [x] Fixture tracer setup: add a committed minimal decoded-save JSON fixture, a generated encoded `.dat` fixture, and a committed generator script used only to regenerate fixtures, not by default tests.
- [x] Public decode tracer bullet: `decodeEncodedSave` decodes the encoded fixture through the public `packages/core` Interface and returns an object with `playerData`.
- [x] Public parse slice: `parseDecodedSave` validates the decoded fixture through the public `packages/core` Interface and exposes summary fields such as `completionPercentage`, `playTime`, `geo`, and `ShellShards`.
- [x] JSON upload slice: `parseDecodedSave` accepts a decoded JSON-style fixture without requiring `decodeEncodedSave`.
- [x] Core end-to-end slice: `decodeEncodedSave -> parseDecodedSave -> createSemanticSnapshot(getBuiltinMappingData())` produces semantic summary metrics from the encoded fixture.
- [x] Failure classification slice: invalid or truncated encoded bytes produce a decode failure, while successfully decoded but unsupported save shapes produce an unrecognized-schema/parse failure.
- [x] Optional local smoke slice: document or provide a gitignored command for testing real local saves through the same public core Interface using `SILKSONG_SAVE_DIR`, without committing personal `user*.dat` files.

Verification:

- `pnpm --filter @silksong-git/core test`: passed
- `pnpm --filter @silksong-git/core fixtures:generate`: passed; regenerated fixture hash stayed stable.
- `SILKSONG_SAVE_DIR=/home/fym/.config/unity3d/Team Cherry/Hollow Knight Silksong/1225542096 pnpm --filter @silksong-git/core smoke:local-saves`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- Added `decodeEncodedSave`, `parseDecodedSave`, `DecodeEncodedSaveError`, and `UnrecognizedSaveSchemaError` to the public `packages/core` Interface.
- Added a generated minimal encoded save fixture plus decoded JSON source and committed generator script.
- Added `smoke:local-saves` as an opt-in local command; it reads real local `user*.dat` files through core but does not commit personal saves.
- `apps/web` behavior remains unchanged; routing Web through the core decoder/parser remains P6-T1 work.

### P3-T4 Core Semantic Diff

Status: complete

Depends on:

- P3-T3

Owned files or likely files:

- `packages/core/`
- semantic diff tests and fixtures

Relevant docs and ADRs:

- [ADR-0002](adr/0002-item-level-semantic-events.md)
- [ADR-0003](adr/0003-semantic-snapshot-coverage.md)
- [ADR-0014](adr/0014-numeric-semantic-event-rules.md)
- [ADR-0015](adr/0015-version-stamps-for-decoding-and-semantic-mapping.md)

Acceptance criteria:

- Two Semantic Snapshots produce item-level Semantic Events.
- Numeric threshold, stage, summary metric, and regression rules are represented according to ADR-0014.
- Tests use `diffSemanticSnapshots`.

TDD Vertical Slices:

- [x] Tracer bullet: a scene-scoped item changing from `missing` to `done` produces an item-level Semantic Event through `diffSemanticSnapshots`.
- [x] Quest state transitions preserve `accepted` and `done` states in Semantic Events.
- [x] Numeric stage threshold crossings produce one item-level Semantic Event for each crossed stage.
- [x] Journal progress records partial value changes and completion threshold changes.
- [x] Save Summary Metric changes produce complete Semantic Events.
- [x] Backward item and numeric transitions produce Regression Events.

Verification:

- `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- Added public `diffSemanticSnapshots` and Semantic Event types to `packages/core`.
- Diff events include item status changes, journal partial value changes, summary metric changes, version stamps, source references, direction, and regression classification.
- Display Semantic Event Filters remain outside `packages/core`; P4 history/query code will apply them at query time.

## P4 History Module

### P4-T1 Raw Observation Restore Tracer Bullet

Status: complete

Depends on:

- P3-T3

Owned files or likely files:

- `packages/history/`
- history integration tests

Relevant docs and ADRs:

- [ADR-0001](adr/0001-save-history-artifacts.md)
- [ADR-0005](adr/0005-single-save-history-repository.md)
- [ADR-0006](adr/0006-save-history-repository-layout.md)
- [ADR-0007](adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)
- [ADR-0016](adr/0016-commit-unrecognized-schema-observations.md)

Acceptance criteria:

- `initSaveHistory` creates a single-save Save History Repository.
- `observeSave` commits `save.dat`, `decoded-save.json`, and `observation.json`.
- `restoreEncodedSave` restores bytes equal to the observed Encoded Save.
- Tests use temporary directories, real Git, and real SQLite where practical.

TDD Vertical Slices:

- [x] Init creates a Save History Repository
  - Public call: `initSaveHistory({ repoPath, watchedSavePath })`
  - Assert: repo path exists, `.silksong-git/config.json` exists, and the result includes `repoPath` and `configPath`.
  - Fixture: temporary directory plus the committed minimal encoded save fixture path as `watchedSavePath`.
  - Other information: this is the first tracer bullet and should not require an initial observation commit.
- [x] Observe commits a recognized Raw Save Observation
  - Public call: `initSaveHistory({ repoPath, watchedSavePath })`, then `observeSave({ repoPath, observedAt })`.
  - Assert: result is `status: "committed"`; schema is `recognized`; `decoderVersion`, `saveSchemaVersion`, hashes, and commit metadata are present; `save.dat`, `decoded-save.json`, and `observation.json` exist in the repository worktree.
  - Fixture: `packages/core/src/decode/fixtures/minimal-valid-save.dat`.
  - Other information: tests should not inspect internal Git adapter calls.
- [x] Restore writes the observed Encoded Save byte-for-byte
  - Public call: `restoreEncodedSave({ repoPath, commitRef, target: { kind: "path", path } })` after a recognized observation commit.
  - Assert: restored file bytes equal the original Encoded Save bytes and result includes the target path, commit, and written hash.
  - Fixture: `packages/core/src/decode/fixtures/minimal-valid-save.dat`.
  - Other information: this completes the minimal P4-T1 end-to-end path: init -> observe -> restore.
- [x] Observe skips an unchanged save
  - Public call: call `observeSave({ repoPath })` twice after `initSaveHistory`.
  - Assert: the second result is `status: "skipped"` with `reason: "unchanged"` and returns the encoded hash.
  - Fixture: `packages/core/src/decode/fixtures/minimal-valid-save.dat`.
  - Other information: verifies raw history does not grow for identical bytes.
- [x] Decode failure is a Watcher Error and commits nothing
  - Public call: `observeSave({ repoPath })` with invalid bytes at the Watched Save path.
  - Assert: result is `status: "watcherError"` with a decode-failure reason, and no new Raw Save Observation is committed.
  - Fixture: temporary invalid `.dat` file.
  - Other information: covers the distinction between Watcher Error and Unrecognized Schema Observation.
- [x] Unrecognized schema is committed without semantic update
  - Public call: `observeSave({ repoPath })` with bytes that decode successfully but fail `parseDecodedSave`.
  - Assert: result is `status: "committed"`; schema is `unrecognized`; `semanticUpdate.status` is `notAvailable`; restore remains byte-for-byte from the committed observation.
  - Fixture: generated encoded save fixture with an unsupported decoded shape.
  - Other information: covers ADR-0016 and should still commit `save.dat`, `decoded-save.json`, and `observation.json`.
- [x] Restore refuses implicit overwrite
  - Public call: `restoreEncodedSave({ repoPath, commitRef, target: { kind: "path", path } })` where the target path already exists.
  - Assert: restore fails without changing the existing target file unless overwrite is explicit.
  - Fixture: observed minimal encoded save plus a pre-existing temporary restore target.
  - Other information: this is the smallest restore safety slice; in-place restore can remain future work.

Verification:

- `pnpm --filter @silksong-git/history test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- Pre-implementation wiring added the `@silksong-git/history` package root export, test scripts, workspace dependency on `@silksong-git/core`, TypeScript include coverage, a minimal public seam, and internal directory placeholders.
- Pre-implementation setup verification: `pnpm format` passed; `pnpm lint` passed.
- Implemented P4-T1 in seven vertical TDD slices through the public `packages/history` Interface.
- `initSaveHistory`, `observeSave`, and `restoreEncodedSave` now cover the minimal raw observation and restore path with temporary directories and real Git.
- Project TypeScript target and lib were raised to `ES2024` during P4-T1 to match formatter output for modern regular expression flags.
- Core fixture generation now also produces `unrecognized-schema-save.dat`, so history tests do not duplicate Encoded Save codec details.

### P4-T2 Rebuild And Query Semantic Read Model

Status: complete

Depends on:

- P4-T1
- P3-T4

Owned files or likely files:

- `packages/history/`
- SQLite read model implementation and migrations
- history integration tests

Relevant docs and ADRs:

- [ADR-0001](adr/0001-save-history-artifacts.md)
- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)
- [ADR-0015](adr/0015-version-stamps-for-decoding-and-semantic-mapping.md)

Acceptance criteria:

- `rebuildSemanticReadModel` rebuilds SQLite from raw observation commits.
- `queryHistory`, `diffCommits`, and `searchSemanticEvents` work through the history Interface.
- SQLite schema remains private to `packages/history`.

TDD Vertical Slices:

- [x] Rebuild and query recognized Semantic Events
  - Public call: `initSaveHistory({ repoPath, watchedSavePath })`, `observeSave({ repoPath })` for two recognized Encoded Saves, then `rebuildSemanticReadModel({ repoPath })` and `queryHistory({ repoPath })`.
  - Assert: rebuild reports two recognized observations, two snapshots, and one or more Semantic Events; query returns events with `commit`, `previousCommit`, `observation`, `event`, and `visibility` metadata.
  - Fixture: generated committed encoded save pair whose decoded saves differ by one stable semantic item.
  - Other information: this is the P4-T2 tracer bullet; tests must not inspect SQLite tables directly.
- [x] Rebuild preserves unrecognized observations without Semantic Snapshots
  - Public call: observe one recognized Encoded Save and one unrecognized-schema Encoded Save, then `rebuildSemanticReadModel({ repoPath })` and `queryHistory({ repoPath, includeRawObservations: true })`.
  - Assert: rebuild counts recognized and unrecognized observations separately; the unrecognized observation is returned as raw observation metadata but produces no Semantic Snapshot or Semantic Event.
  - Fixture: `packages/core/src/decode/fixtures/unrecognized-schema-save.dat` plus a recognized encoded save fixture.
  - Other information: covers ADR-0016 behavior during rebuild, not only during live observation.
- [x] Query history supports raw observations and pagination
  - Public call: create at least three recognized observations, rebuild, then call `queryHistory({ repoPath, includeRawObservations: true, limit })` followed by the returned cursor.
  - Assert: event pages are stable and non-overlapping; `rawObservations` is present only when requested; every returned event still includes its Raw Save Observation metadata.
  - Fixture: generated committed encoded save sequence with multiple semantic transitions.
  - Other information: cursor format remains opaque to callers.
- [x] Diff commits returns Semantic Snapshots and Historical Semantic Events
  - Public call: observe two recognized saves, rebuild, then `diffCommits({ repoPath, fromRef, toRef })`.
  - Assert: result includes the resolved `from` and `to` commits, `before` and `after` Semantic Snapshots, and the Semantic Events between those two commits with commit and observation metadata.
  - Fixture: generated committed encoded save pair whose decoded saves differ by one stable semantic item.
  - Other information: this verifies semantic diff behavior through history, not direct calls to `packages/core` from tests.
- [x] Search Semantic Events by structured fields
  - Public call: rebuild a repository with multiple Semantic Events, then `searchSemanticEvents({ repoPath, query: { itemId } })` and at least one additional structured query such as `statusTo`, `eventType`, or `direction`.
  - Assert: search returns only matching `HistoricalSemanticEvent` rows and preserves commit, previous commit, observation, event, and visibility metadata.
  - Fixture: generated committed encoded save sequence with at least two distinct event types or items.
  - Other information: structured fields are the stable programmatic Interface.
- [x] Search Semantic Events by free text
  - Public call: rebuild a repository with multiple Semantic Events, then `searchSemanticEvents({ repoPath, query: { text } })`.
  - Assert: free-text search finds matching event labels or related searchable event text and excludes unrelated events.
  - Fixture: generated committed encoded save sequence with distinguishable labels.
  - Other information: this supports the CLI `history search --event <text>` convenience while keeping structured search as the preferred Interface.
- [x] Query filtering annotates default visibility without deleting events
  - Public call: rebuild observations that produce both default-visible and default-hidden Semantic Events, then call `queryHistory({ repoPath })` and `queryHistory({ repoPath, includeFiltered: true })`.
  - Assert: default queries hide filtered events or mark them according to the public query contract; `includeFiltered` returns the complete stored event set with `visibility.filterReasons`; rebuild counts still include the complete event set.
  - Fixture: generated committed encoded save sequence that produces a noisy Save Summary Metric or currency-only event.
  - Other information: Display Semantic Event Filters are query-time behavior and must not affect Git commits or remove events from the SQLite Semantic Read Model.

Verification:

- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm --filter @silksong-git/history test`: passed

Notes:

- Implemented the SQLite Semantic Read Model behind the `packages/history` public Interface.
- `rebuildSemanticReadModel` rebuilds observations, recognized Semantic Snapshots, and adjacent Semantic Events from Git raw observation commits.
- `queryHistory`, `diffCommits`, and `searchSemanticEvents` return events with commit and Raw Save Observation metadata without exposing SQLite tables.
- Display Semantic Event Filters are applied at query/diff/search time; filtered events remain stored in the read model and are returned with `includeFiltered`.
- Follow-up alignment: `diffCommits` now accepts `includeFiltered` and uses the same visibility/filter behavior as `queryHistory` and `searchSemanticEvents`.
- Read model internals were split under `packages/history/src/read-model/`; the public history Interface and SQLite schema privacy remain unchanged.

### P4-T3 Manual Checkpoint Observation Semantics

Status: complete

Depends on:

- P4-T1
- P4-T2

Owned files or likely files:

- `packages/history/`
- history integration tests
- `docs/save-history-design.md`
- `CONTEXT.md`
- related ADRs

Relevant docs and ADRs:

- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- `observeSave` supports user-requested manual checkpoints through the public history Interface.
- Manual checkpoints bypass unchanged-save and minimum-interval skip rules.
- Manual checkpoints still report decode failures without committing.
- Raw Save Observation metadata records the observation trigger and optional checkpoint message.
- Watcher observations and manual checkpoints acquire the same Save History Repository write lock before mutating Git artifacts.

Verification:

- `pnpm --filter @silksong-git/history test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Notes:

- Added `trigger: "watcher" | "manualCheckpoint"` and optional `message` to Raw Save Observation metadata.
- Added a repository-local `.silksong-git/write.lock` for history write serialization.
- Manual checkpoint CLI parsing remains part of P5 history CLI implementation.

## P5 CLI

### P5-T1 Implement Save CLI Commands

Status: complete

Depends on:

- P3-T3

Owned files or likely files:

- `apps/cli/`
- CLI tests

Relevant docs and ADRs:

- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0012](adr/0012-core-semantic-module-interface.md)

Acceptance criteria:

- `silksong-git save ...` commands syntax matches `docs/save-history-design.md`.
- Decode failure exits 2 for both `save decode` and `save snapshot`.
- Unknown schema exits 3 for `save snapshot` by default and suggests `save decode` for raw debugging.
- Semantic Snapshot JSON is stable enough for tests.

Verification:

- `pnpm --filter @silksong-git/cli test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm test`: passed

Notes:

- Added `apps/cli/src/main.ts` with Commander-backed `save decode` and `save snapshot` commands.
- `save decode` outputs `decodeEncodedSave(bytes).decodedSave`, supports `--compact`, `--out`, and `--schema-check`, and maps decode failures to exit 2.
- `save snapshot` requires `--json`, outputs the `SemanticSnapshot` object directly, maps decode failures to exit 2, and maps unrecognized schema to exit 3 with a `save decode` suggestion.
- Added end-to-end CLI tests that execute the CLI entry point through `tsx`.

### P5-T2 Implement Repo And History CLI Workflow

Status: complete

Depends on:

- P4-T2

Owned files or likely files:

- `apps/cli/`
- CLI tests

Relevant docs and ADRs:

- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- The P5-T2 repo and history command behavior matches `docs/save-history-design.md`; that document remains the only source for concrete command grammar and flags.
- Repo initialization and history workflow commands call `packages/history` rather than Git or SQLite directly.
- The implemented workflow lets a user create a Save History Repository, record a manual checkpoint, inspect/query/diff history, and rebuild the Semantic Read Model through CLI output.
- Repo/history commands default to readable text and support stable `--json` where documented.
- Manual checkpoint records through the public history Interface, bypasses minimum-interval suppression as documented, handles unchanged saves through the documented explicit option, and maps decode failure and busy-repository cases to the documented exit behavior.
- Repository-scoped commands share one repo context resolver and follow the documented resolution order.
- CLI source is split so command registration, save commands, repo/history commands, repo context resolution, output formatting, and exit-code constants stay locally understandable.
- Repo context resolution has focused tests, and command behavior is covered by end-to-end CLI process tests.

TDD Vertical Slices:

Phase A: History Interface Semantics

- [x] History manual checkpoint skips unchanged Encoded Save bytes by default
  - Public call: `observeSave` through `packages/history`.
  - Assert: a second manual checkpoint of unchanged bytes returns a skipped unchanged result and creates no new Raw Save Observation.
  - Other information: this updates the history Module behavior before CLI code depends on it.
- [x] History manual checkpoint can explicitly allow unchanged Encoded Save bytes
  - Public call: `observeSave` through `packages/history`.
  - Assert: an explicit allow-unchanged manual checkpoint commits unchanged bytes while manual checkpoints still bypass minimum-interval suppression.
  - Other information: avoid exposing low-level Capture Policy bypass switches to CLI callers.
- Natural commit boundary: history Interface behavior is green.

Phase B: CLI Structure And Repository Entry

- [x] CLI source is split while existing save commands stay green
  - Public call: existing CLI process tests.
  - Assert: current save command behavior is unchanged after moving command registration, save command handlers, output helpers, and exit-code constants behind smaller CLI Modules.
  - Other information: refactor only while green; this prepares the CLI Adapter for repo/history commands without changing user behavior.
- [x] CLI can initialize a Save History Repository
  - Public call: CLI process.
  - Assert: repo initialization succeeds, writes Project Config, emits stable JSON when requested, and stores absolute Watched Save and repository paths.
  - Other information: `repo init` does not decode the save and does not create an initial observation.
- [x] CLI refuses unsafe or invalid repository initialization
  - Public call: CLI process.
  - Assert: invalid Watched Save paths and non-empty target directories fail with usage/configuration behavior.
  - Other information: cover representative safety failures instead of every filesystem error.
- [x] CLI resolves repository context consistently
  - Public call: repo context resolver Module and at least one repository-scoped CLI command.
  - Assert: explicit repo path wins, cwd discovery walks upward to the nearest Save History Repository, and missing context fails as documented.
  - Other information: keep this as a small shared CLI Module with focused tests.
- Natural commit boundary: repo initialization and context resolution are green.

Phase C: Manual Checkpoint CLI

- [x] CLI records a manual checkpoint
  - Public call: CLI process.
  - Assert: checkpoint command records a Raw Save Observation through `packages/history`, outputs stable JSON when requested, and records trigger/message metadata.
  - Other information: this is the first end-to-end repo/history workflow slice after repo init.
- [x] CLI handles unchanged manual checkpoint behavior
  - Public call: CLI process.
  - Assert: unchanged checkpoint defaults to a skipped result with a text hint, and the documented explicit option records the checkpoint.
  - Other information: JSON output remains the public history result body without extra CLI hints.
- [x] CLI maps checkpoint failures
  - Public call: CLI process.
  - Assert: decode failure maps to the documented exit behavior; repository-busy behavior is covered if the setup remains practical.
  - Other information: do not commit a Raw Save Observation on decode failure.
- Natural commit boundary: manual checkpoint CLI workflow is green.

Phase D: Read Model And History Queries

- [x] CLI rebuilds the Semantic Read Model
  - Public call: CLI process.
  - Assert: rebuilding an empty repository succeeds with zero counts, and rebuilding after observations reports the public rebuild result.
  - Other information: rebuild may mutate SQLite but must not rewrite Git history.
- [x] CLI lists Semantic Event history
  - Public call: CLI process.
  - Assert: list returns the public history result in JSON mode, readable empty output when there are no events, and documented pagination validation.
  - Other information: raw-observation listing is intentionally not exposed in P5-T2.
- [x] CLI searches Semantic Event history
  - Public call: CLI process.
  - Assert: at least one query flag is required, structured query flags work, free-text event search works as a convenience, and invalid enum values fail as usage errors.
  - Other information: structured fields remain the stable search Interface.
- [x] CLI diffs two history commits
  - Public call: CLI process.
  - Assert: diff returns the public diff result in JSON mode, no-change diffs are successful empty results, missing snapshots map to semantic-unavailable behavior, and invalid refs are usage errors.
  - Other information: include-filtered and read-model-unavailable behavior can be covered on the smallest command surface that proves the shared mapping.
- Natural commit boundary: read-model rebuild and history query commands are green.

Verification:

- `pnpm format`: passed
- `pnpm lint`: passed
- CLI test command: `pnpm --filter @silksong-git/cli test`: passed
- `pnpm test`: passed

### P5-T3 Implement History Restore CLI Command

Status: complete

Depends on:

- P5-T2

Owned files or likely files:

- `apps/cli/`
- CLI tests

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0007](adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- Restore command behavior matches `docs/save-history-design.md`; that document remains the source for concrete command grammar and flags.
- This task implements only explicit-target restore: `history restore <commit> --to <path>`.
- Existing target paths fail without overwriting; `--overwrite` and in-place restore are intentionally out of scope for this task.
- Restore calls `packages/history` rather than Git or filesystem history internals directly.
- Restore requires explicit restore intent and preserves the documented no-implicit-overwrite safety behavior.
- Restore errors are mapped to documented CLI exit behavior and messages.
- Command behavior is covered by end-to-end CLI process tests.

Verification:

- `pnpm --filter @silksong-git/history test`: passed
- `pnpm --filter @silksong-git/cli test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm test`: passed

Notes:

- Added `history restore <commit> --to <path>` as an explicit-target restore command.
- The command restores the committed `save.dat` byte-for-byte through `packages/history.restoreEncodedSave`.
- Existing restore targets fail without overwrite and are reported through the public `RestoreTargetExistsError`.
- In-place restore remains P5-T4.

### P5-T4 Implement In-Place History Restore

Status: pending

Depends on:

- P5-T3

Owned files or likely files:

- `packages/history/`
- `apps/cli/`
- history and CLI tests

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0007](adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- In-place restore is exposed as an explicit high-risk mode, for example `history restore <commit> --in-place --confirm-in-place [--repo <history-repo>]`.
- The restore target is the `watchedSavePath` from Project Config, not an arbitrary CLI path.
- Missing confirmation fails as a usage error without writing the watched save.
- A backup of the existing watched save is created before overwriting it.
- In-place restore uses the `packages/history` public Interface and the same repository write lock as watcher observations and manual checkpoints.
- Restore errors are mapped to documented CLI exit behavior and messages.
- Behavior is covered through public history Interface tests and end-to-end CLI process tests.

Verification:

- `pnpm format`: pending
- `pnpm lint`: pending
- Relevant test command: pending

### P5-T5 Implement Watch CLI Command

Status: pending

Depends on:

- P5-T2

Owned files or likely files:

- `apps/cli/`
- `packages/history/`
- CLI and history process tests as needed

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- Watch command behavior matches `docs/save-history-design.md`; that document remains the source for concrete command grammar and flags.
- The command starts the Local History API Process through `packages/history`.
- Watcher lifecycle, repository locking, status output, and shutdown behavior are documented and tested at the appropriate Interface.
- The process remains the single owner of watching, history writes, read-model updates, and local history endpoints.

Verification:

- `pnpm format`: pending
- `pnpm lint`: pending
- Relevant test command: pending

## P6 Web Integration

### P6-T1 Route Current Save Flow Through Core

Status: complete

Depends on:

- P3-T3

Owned files or likely files:

- `apps/web/`
- current Web UI tests or smoke checks

Relevant docs and ADRs:

- `docs/current-design-reference/overview.md`
- `docs/current-design-reference/save-to-semantic.md`
- [ADR-0009](adr/0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0012](adr/0012-core-semantic-module-interface.md)

Acceptance criteria:

- Static Web Mode preserves the existing upload/current-save behavior.
- Current save rendering uses `packages/core` instead of duplicated mapping logic.
- User-visible behavior is unchanged.

Verification:

- `pnpm --filter @silksong-git/web build`: passed
- `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed
- Static Web Mode smoke test with committed encoded and decoded fixtures: passed; manually verified by the user with no issues found.

Notes:

- Static Web Mode now calls `decodeEncodedSave`, `parseDecodedSave`, `getBuiltinMappingData`, and `createSemanticSnapshot` from `@silksong-git/core`.
- Raw Save tab still renders the raw Decoded Save JSON rather than Semantic Snapshot JSON.
- Progress cards, category counts, missing filter, mode filter, and map pins read from Semantic Snapshot items while preserving the old Web presentation behavior, including collected relic/materium/device compatibility.
- Mapping JSON and schema validation ownership moved to `packages/core/src/data`; duplicated Web data files and Web-local decoder/parser files were removed.
- `apps/web` now depends on `@silksong-git/core` and no longer directly depends on `crypto-js`, `zod`, or `@types/crypto-js`.

### P6-T2 Add Local History Web Mode

Status: pending

Depends on:

- P4-T2
- P6-T1

Owned files or likely files:

- `apps/web/`
- local HTTP adapter
- local endpoint connection and capability handling
- local history UI views

Relevant docs and ADRs:

- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0009](adr/0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)

Acceptance criteria:

- Local History Web Mode is enabled when the frontend connects to a compatible local HTTP endpoint.
- Local History Web Mode shows Current Save, History, Diff, Search, Watcher, and Restore/Export views.
- HTTP endpoints are adapters over `packages/history`.
- Web code does not query SQLite or run Git operations directly.
- Frontend serving stays decoupled from the Local History API Process; Vite is acceptable for implementation and debugging.

Verification:

- `pnpm format`: pending
- `pnpm lint`: pending
- Web test/build command: pending
- local Web UI smoke test: pending

### P6-T3 Add UI Open CLI Workflow

Status: pending

Depends on:

- P6-T2

Owned files or likely files:

- `apps/cli/`
- `apps/web/`
- local Web UI connection helpers
- CLI tests or smoke checks

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0009](adr/0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)

Acceptance criteria:

- UI open behavior matches `docs/save-history-design.md`; that document remains the source for concrete command grammar and flags.
- The command opens or serves the Web UI client without becoming a second history writer.
- Local endpoint discovery or connection behavior is explicit and compatible with Local History Web Mode.
- The command does not make Web code call Git, SQLite, watcher, or history internals directly.

Verification:

- `pnpm format`: pending
- `pnpm lint`: pending
- Relevant test or smoke command: pending
