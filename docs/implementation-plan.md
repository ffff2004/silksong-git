# Implementation Plan

This document is the execution tracker for the save-history fork. It records phase order, task dependencies, current progress, acceptance criteria, and verification results so future agents can continue without chat history.

For architecture and rationale, read `docs/save-history-design.md`, `CONTEXT.md`, and the relevant ADRs. This document should not repeat their design detail.

## Current Status

- Current phase: P6 Web Integration
- Next task: P6-T3 Add Local History Web Mode
- Last updated: 2026-07-14

## Phase Overview

| Phase                                 | Status      | Depends On | Goal                                                                                                                     |
| ------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| P1 Documentation / Repository Hygiene | complete    | none       | Documentation is coherent, old references are moved, and validation passes.                                              |
| P2 Workspace Skeleton                 | complete    | P1         | pnpm workspace exists while existing Web behavior remains unchanged.                                                     |
| P3 Core Semantic Module               | complete    | P2         | `packages/core` exposes decode, parse, snapshot, and diff behavior through a small public Interface.                     |
| P4 History Module                     | complete    | P3         | Raw observations, restore, and SQLite Semantic Read Model work through `packages/history`.                               |
| P5 CLI                                | complete    | P3, P4     | First object-grouped CLI command set works through core/history Interfaces.                                              |
| P6 Web Integration                    | in progress | P3, P4     | Web UI uses core, keeps static mode working, and gains the Solid routing/state foundation needed for local history mode. |

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

### P1-T2 Show Formatter-Only Diffs

Status: complete

Depends on:

- P1-T1

Owned files:

- `scripts/format.ts`
- `package.json`
- `pnpm-lock.yaml`

Relevant docs and ADRs:

- none

Acceptance criteria:

- `pnpm format` keeps reporting when no files change.
- Successful formatting reports the changed files and a unified diff containing only changes from the current formatter run.
- If formatting modifies a file before failing, the unified diff is still reported and the command retains its failure exit code.

Verification:

- `pnpm format scripts/pnpm-exec.ts`: passed; reported no changed files.
- `pnpm format scripts/format-smoke-success.ts`: passed against a temporary untracked fixture; reported the formatter-only unified diff.
- `pnpm format scripts/format-smoke-success.ts scripts/format-smoke-failure.ts`: exited with code 1 against temporary untracked fixtures after ESLint changed `var` to `let`; reported that diff before preserving the ESLint failure.
- `pnpm format scripts/format.ts package.json pnpm-lock.yaml`: passed; reported no changed files after implementation formatting.
- `pnpm format`: passed before commit.
- `pnpm verify`: passed before commit.

Notes:

- The temporary smoke fixtures were removed after verification.
- `diff` is a direct root development dependency rather than relying on its existing transitive installation.

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
  - Other information: covers ADR-0016 behavior during rebuild, not only during live observation. This records the Interface at P4-T2 completion; P5-T7 later replaced combined raw-observation results with independent `queryRawObservations` pagination.
- [x] Query history supports raw observations and pagination
  - Public call: create at least three recognized observations, rebuild, then call `queryHistory({ repoPath, includeRawObservations: true, limit })` followed by the returned cursor.
  - Assert: event pages are stable and non-overlapping; `rawObservations` is present only when requested; every returned event still includes its Raw Save Observation metadata.
  - Fixture: generated committed encoded save sequence with multiple semantic transitions.
  - Other information: cursor format remains opaque to callers. This records the Interface at P4-T2 completion; P5-T7 superseded it with separate `queryHistory` and `queryRawObservations` results and cursors.
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

Phase C: Manual Checkpoint CLI

- [x] CLI records a manual checkpoint
  - Public call: CLI process.
  - Assert: checkpoint command records a Raw Save Observation through `packages/history`, outputs stable JSON when requested, and records trigger/message metadata.
  - Other information: this is the first end-to-end repo/history workflow slice after repo init.
- [x] CLI checkpoint text output reports newly added Semantic Events
  - Public call: CLI process.
  - Assert: default text output for a committed checkpoint includes the new event count and readable event summaries from `SemanticUpdateResult.events`.
  - Other information: JSON output remains the public `ObserveSaveResult` body.
- [x] CLI handles unchanged manual checkpoint behavior
  - Public call: CLI process.
  - Assert: unchanged checkpoint defaults to a skipped result with a text hint, and the documented explicit option records the checkpoint.
  - Other information: JSON output remains the public history result body without extra CLI hints.
- [x] CLI maps checkpoint failures
  - Public call: CLI process.
  - Assert: decode failure maps to the documented exit behavior; repository-busy behavior is covered if the setup remains practical.
  - Other information: do not commit a Raw Save Observation on decode failure.

Phase D: Read Model And History Queries

- [x] CLI rebuilds the Semantic Read Model
  - Public call: CLI process.
  - Assert: rebuilding an empty repository succeeds with zero counts, and rebuilding after observations reports the public rebuild result.
  - Other information: rebuild may mutate SQLite but must not rewrite Git history.
- [x] CLI lists Semantic Event history
  - Public call: CLI process.
  - Assert: list returns the public history result in JSON mode, readable Semantic Event text in default mode, readable empty output when there are no events, and documented pagination validation.
  - Other information: raw-observation listing is intentionally not exposed in P5-T2.
- [x] CLI searches Semantic Event history
  - Public call: CLI process.
  - Assert: at least one query flag is required, structured query flags work, free-text event search works as a convenience, default text output renders readable Semantic Events, and invalid enum values fail as usage errors.
  - Other information: structured fields remain the stable search Interface.
- [x] CLI diffs two history commits
  - Public call: CLI process.
  - Assert: diff returns the public diff result in JSON mode, default text output renders readable Semantic Events, no-change diffs are successful empty results, missing snapshots map to semantic-unavailable behavior, and invalid refs are usage errors.
  - Other information: include-filtered and read-model-unavailable behavior can be covered on the smallest command surface that proves the shared mapping.

Verification:

- RED: `pnpm --filter @silksong-git/cli test`: failed as expected before text rendering used `SemanticUpdateResult.events`; checkpoint output only included the commit.
- `pnpm --filter @silksong-git/cli format`: passed
- `pnpm --filter @silksong-git/cli lint`: passed
- `pnpm --filter @silksong-git/cli test`: passed
- RED: `pnpm --filter @silksong-git/cli test`: failed as expected before `history list`, `history search`, and `history diff` default text output reused the shared Semantic Event formatter; each still printed only the event type.
- `pnpm --filter @silksong-git/cli test`: passed
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

Status: complete

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
- `--to` and `--in-place` are mutually exclusive restore target modes.
- The restore target is the `watchedSavePath` from Project Config, not an arbitrary CLI path.
- Missing confirmation fails as a usage error without writing the watched save.
- `restore.backupDirectory`, when configured, must be an absolute path.
- A backup of the existing watched save is created before overwriting it, using `<original-basename>.before-restore.<timestamp>.dat` with bounded collision retries.
- Missing watched save is restored without a backup.
- Restore writes no Raw Save Observation by itself.
- In-place restore uses the `packages/history` public Interface and the same repository write lock as watcher observations and manual checkpoints.
- Restore reads back the watched save and verifies the written hash before reporting success.
- Restore errors are mapped to documented CLI exit behavior and messages.
- Behavior is covered through public history Interface tests and end-to-end CLI process tests.

Verification:

- `pnpm --filter @silksong-git/history test`: passed
- `pnpm --filter @silksong-git/cli test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm test`: passed

Notes:

- Added `history restore <commit> --in-place --confirm-in-place` through the history public Interface.
- In-place restore reads `watchedSavePath` from Project Config, creates bounded-collision backups for existing watched saves, allows restore when the watched save is missing, and verifies the written hash before reporting success.
- `restore.backupDirectory` must be absolute when configured.
- Restore itself does not create a Raw Save Observation; watcher/manual checkpoint workflows can record the resulting file state separately.
- Added public restore domain errors for invalid backup directories, backup failure, write failure, and write verification failure.

### P5-T5 Implement Watch Runtime And CLI Command

Status: complete

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
- The command starts the Local History Watch Process through `packages/history` without requiring the HTTP Adapter.
- The process is a singleton per Save History Repository and holds a long-lived `.silksong-git/watch.lock`; stale locks are not removed automatically, and lock conflicts report diagnostic lock details.
- The process uses a Project Config snapshot read at startup. Runtime config changes require restarting the watcher; one-shot Offline Commands continue reading current Project Config.
- The watcher attaches its backend before requesting a synthetic startup observation. Startup skips debounce but still uses stability probing.
- Real file events use `capturePolicy.debounceWriteMs`, bounded size/mtime stability probing, single-flight observation, and a dirty bit to coalesce event bursts.
- Watcher observations call the history observation path with trigger `watcher`, record Raw Save Observations through the shared observation implementation, and rely on its incremental Semantic Read Model update instead of running full rebuilds.
- `minimumCommitIntervalMs <= 0` disables interval suppression. When a watcher observation is skipped by `minimumCommitInterval`, the result includes the next allowed time, and the watcher keeps one deferred observation timer that skips debounce but still probes stability before reading the current Watched Save.
- Watcher Error reporting distinguishes save read/decode/stability problems, which do not stop the process, from watch backend or process ownership failures, which are fatal process errors.
- Watcher lifecycle and shutdown are graceful: pending timers can be canceled, running observations are allowed to finish, `watch.lock` is released, and stopped status is emitted.
- `packages/history` exposes structured Local History Watch Process events; CLI rendering is an Adapter over those events.
- `watch start --jsonl` emits compact stable JSON Lines status events to stdout. Default human-readable runtime logs go to stderr and are not byte-stable.
- CLI output stream failure gracefully stops the watcher and exits as a failure.
- The process remains the single owner of watching while allowing checkpoint, restore, and rebuild Offline Commands to serialize with watcher writes through `write.lock`.
- P5-T5 registers `--http` and `--port` as clear usage errors; P5-T7 implements their behavior.

TDD Vertical Slices:

- [x] `observeSave` minimum-interval skip returns `nextAllowedAt`
  - Public call: `observeSave`.
  - Assert: watcher-triggered observation inside `minCommitIntervalMs` returns `skipped` with reason `minimumCommitInterval`, `encodedSha256`, and `nextAllowedAt`.
  - Other information: `minimumCommitIntervalMs <= 0` disables the skip path; manual checkpoint remains outside minimum-interval suppression.
- [x] Refactor observation internals to support a Project Config snapshot
  - Public call: existing `observeSave` tests and CLI checkpoint tests.
  - Assert: existing public behavior remains green with no new behavior test for the internal helper.
  - Other information: this is a GREEN-state preparatory refactor. Public `observeSave` still reads current Project Config and acquires `write.lock`; the watcher runtime will later call an internal observation helper with the startup config snapshot while holding `write.lock`.
- [x] Watch process startup tracer bullet
  - Public call: `startLocalHistoryWatchProcess`.
  - Assert: the process emits `started` with repo path, Watched Save path, and Capture Policy snapshot, then performs a startup observation through the watcher path.
  - Other information: attach the watch backend before requesting the synthetic startup dirty event; startup skips debounce but still waits for stability.
- [x] Watch process stops gracefully
  - Public call: `startLocalHistoryWatchProcess`, then `LocalHistoryWatchProcess.stop()`.
  - Assert: the process emits stopping/stopped events, cancels pending non-started work, allows a running observation to finish, and releases `watch.lock`.
  - Other information: do not implement hard cancellation of Git or SQLite mutation work.
- [x] Watch process is a per-repository singleton
  - Public call: start two Local History Watch Processes for the same Save History Repository.
  - Assert: the second start fails with a process ownership error that reports watch-lock diagnostics; after the first process stops, a new process can start.
  - Other information: do not auto-remove stale `watch.lock` files.
- [x] Watcher observes real file-change events
  - Public call: `startLocalHistoryWatchProcess` with a test watch event source, then public history query/diff Interfaces.
  - Assert: a file-change event followed by debounce and stability records a watcher-triggered Raw Save Observation and updates the Semantic Read Model.
  - Other information: tests may inject event source, clock, and timers as system-boundary seams; do not assert private queue or timer internals.
- [x] Watcher waits for file stability
  - Public call: `startLocalHistoryWatchProcess` with injected clock/timers.
  - Assert: changing `size` or `mtimeMs` delays observation until the Watched Save is stable across probes.
  - Other information: avoid real sleeps.
- [x] Stability timeout is nonfatal
  - Public call: `startLocalHistoryWatchProcess`.
  - Assert: an unstable or unstat-able Watched Save emits a Watcher Error and the process continues to accept later valid file changes.
  - Other information: extend `WatcherError.reason` with `stabilityTimeout`; ordinary save read/decode/stability problems are not process-fatal.
- [x] Watcher coalesces events with single-flight dirty-bit behavior
  - Public call: `startLocalHistoryWatchProcess`.
  - Assert: event bursts and events arriving during a running observation are coalesced into observation passes over the latest stable Watched Save rather than concurrent observations.
  - Other information: verify through resulting history/events, not private queue length.
- [x] Watcher schedules deferred minimum-interval observations
  - Public call: `startLocalHistoryWatchProcess`.
  - Assert: a `minimumCommitInterval` skip schedules one deferred observation at `nextAllowedAt`; the deferred observation skips debounce, still probes stability, and reads the current Watched Save.
  - Other information: if the file returns to the last committed bytes, the deferred observation is skipped as unchanged.
- [x] Watcher handles save Watcher Errors without stopping
  - Public call: `startLocalHistoryWatchProcess`.
  - Assert: startup or runtime decode/read failure emits a Watcher Error and a later valid save change can still be committed.
  - Other information: process-level failures such as backend failure remain separate fatal errors.
- [x] Watch backend failure is fatal
  - Public call: `startLocalHistoryWatchProcess` with a failing watch backend.
  - Assert: backend startup/runtime failure emits a fatal process error, stops gracefully, and releases `watch.lock`.
  - Other information: do not model backend failure as a `WatcherError`.
- [x] CLI starts watch with JSONL output
  - Public call: CLI process `watch start --repo <history-repo> --jsonl`.
  - Assert: stdout emits compact stable JSON Lines status summaries for started and observation events; graceful signal stop exits successfully.
  - Other information: CLI JSONL should not expose the full `ObserveSaveResult` shape.
- [x] CLI output stream failure stops the watcher and exits as failure
  - Public call: CLI process `watch start --repo <history-repo> --jsonl`.
  - Assert: closing the JSONL output stream before a later watcher event produces a controlled failure, exits nonzero, and releases the watch lock so a new watcher can start.
  - Other information: treat the output stream as the system boundary; do not assert internal renderer calls.
- [x] CLI default logs and reserved HTTP flags behave correctly
  - Public call: CLI process.
  - Assert: default watcher runtime logs go to stderr, stdout is not polluted with human-readable status, and `--http` or `--port` fail clearly without starting the watcher.
  - Other information: P5-T7 implements the actual HTTP Adapter behavior.
- [x] CLI default watch logs report newly added Semantic Events
  - Public call: CLI process `watch start --repo <history-repo>`.
  - Assert: default stderr output for watcher observations includes committed observation details, the new event count, and readable event summaries from `SemanticUpdateResult.events`.
  - Other information: `--jsonl` remains a compact stable summary and does not expose full observation results.
- [x] CLI default watch logs include current render timestamps
  - Public call: CLI process `watch start --repo <history-repo>`.
  - Assert: default stderr output prefixes human-readable watcher event blocks with the current local timestamp.
  - Other information: `--jsonl` remains unchanged; timestamps are a human-readable CLI rendering concern.

- CLI default logs and reserved HTTP flags behave correctly:
  - RED: `pnpm --filter @silksong-git/cli test`: failed as expected before implementation; `--http` reported Commander unknown option instead of reserved HTTP Adapter usage.
  - `pnpm --filter @silksong-git/cli format`: passed
  - `pnpm --filter @silksong-git/cli lint`: passed
  - `pnpm --filter @silksong-git/cli test`: passed
- CLI default watch logs report newly added Semantic Events:
  - RED: `pnpm --filter @silksong-git/cli test`: failed as expected before default watch text rendering used `SemanticUpdateResult.events`; change observations logged only the committed status.
  - `pnpm --filter @silksong-git/cli test`: passed
- CLI default watch logs include current render timestamps:
  - RED: `pnpm --filter @silksong-git/cli test`: failed as expected before default watch text rendering prefixed event blocks with timestamps.
  - `pnpm --filter @silksong-git/cli test`: passed

Verification:

- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm test`: passed

### P5-T6 Incrementally Update Semantic Read Model During Observation

Status: complete

Depends on:

- P4-T2
- P5-T5

Owned files or likely files:

- `packages/history/`
- history integration tests

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0001](adr/0001-save-history-artifacts.md)
- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)
- [ADR-0016](adr/0016-commit-unrecognized-schema-observations.md)

Acceptance criteria:

- `observeSave` updates the SQLite Semantic Read Model after committing a Raw Save Observation.
- Recognized observations append raw observation rows, Semantic Snapshots, and Semantic Events without requiring a full rebuild.
- Unrecognized Schema Observations are retained as raw observations but do not produce Semantic Snapshots or Semantic Events.
- Incremental query results match a later full `rebuildSemanticReadModel`.
- Missing or stale read-model state is rebuilt to the previous Git HEAD before appending the newly committed Raw Save Observation.
- The SQLite schema remains private to `packages/history`; tests verify behavior through public history Interfaces.

TDD Vertical Slices:

- [x] First recognized observation creates a queryable Semantic Read Model
  - Public call: `observeSave`, then `queryHistory({ includeRawObservations: true })`.
  - Assert: `semanticUpdate.status` is `updated`, `eventCount` is `0`, and the raw observation is queryable without running `rebuildSemanticReadModel`.
- [x] Second recognized observation records Semantic Events incrementally
  - Public call: two `observeSave` calls for recognized Encoded Saves, then `queryHistory`.
  - Assert: the second observation reports one Semantic Event; the queried event points to the second commit and previous recognized commit.
- [x] Incremental read model matches a full rebuild
  - Public call: observe a recognized fixture sequence, query history, run `rebuildSemanticReadModel`, then query history again.
  - Assert: rebuilt history equals the incremental history, including filtered events and raw observations.
- [x] Unrecognized observations do not interrupt recognized diffs
  - Public call: observe recognized, unrecognized, and recognized saves, then `queryHistory({ includeRawObservations: true })`.
  - Assert: the unrecognized observation appears in raw observations, but the later recognized Semantic Event diffs against the previous recognized commit.
- [x] Missing read model is rebuilt before append
  - Public call: observe one recognized save, delete `.silksong-git/read-model.sqlite`, observe a second recognized save, then query history.
  - Assert: history includes both raw observations and the Semantic Event between them.

Verification:

- RED: `pnpm --filter @silksong-git/history test`: failed as expected before implementation; recognized `observeSave` still returned `semanticUpdate.status: "notAvailable"` and did not create a queryable read model.
- `pnpm --filter @silksong-git/history format`: passed
- `pnpm --filter @silksong-git/history lint`: passed
- `pnpm --filter @silksong-git/history test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed
- `pnpm test`: passed

Notes:

- Added internal read-model append helpers behind the existing `packages/history` Interface.
- `observeSave` still commits the Raw Save Observation first; if SQLite append fails, Git remains the source of truth and the result reports `readModelUnavailable`.
- `insertEventsBetween` lets rebuild and incremental append share the same Semantic Event insertion logic.
- `SemanticUpdateResult` now includes the Semantic Events appended for the current observation so CLI and watcher adapters can render newly observed events without issuing a separate history query.

### P5-T7 Add Optional HTTP Adapter To Watch Process

Status: complete

Depends on:

- P5-T6

Owned files or likely files:

- `apps/cli/`
- `apps/cli/tsup.config.ts`
- `apps/cli/scripts/verify-pack.ts`
- `packages/history/`
- `packages/history/package.json`
- local HTTP adapter tests

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0010](adr/0010-first-version-cli-command-set.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)
- [ADR-0018](adr/0018-secure-versioned-local-http-adapter.md)

Acceptance criteria:

- `watch start --http` atomically enables a Hono + Zod local HTTP Adapter inside the same Local History Watch Process that owns watching, history writes, and read-model updates; enabling HTTP never creates a second watcher, writer, or mutation queue.
- HTTP startup binds only to the fixed loopback host `127.0.0.1`. `watch start --port <port>` accepts only 1 through 65535 and only with `--http`; without `--port`, the server requests port `0`. The host, port, and credentials are not written to Project Config.
- The Local History Watch Process reports one structured `started` event only after watcher ownership, watch backend, and HTTP listener are ready. When HTTP is enabled, that event includes the concrete `http://127.0.0.1:<bound-port>` endpoint and a separate session token; later events and endpoints do not repeat the token.
- Every process start generates a new cryptographically secure bearer token with at least 256 bits of entropy, encoded as unpadded base64url, stored only in memory, compared in constant time, and accepted only through a strict `Authorization: Bearer <token>` header.
- Standard CORS allows any origin without credentials, handles unauthenticated `OPTIONS /api/v1/*` without exposing repository state, permits only required methods and request headers, and exposes `Content-Disposition`, `ETag`, and `Retry-After`. The Adapter does not implement superseded Private Network Access headers.
- All actual `/api/v1` requests, including `meta`, require authentication. JSON POST bodies require `application/json`, use strict Zod objects, and are limited to 16 KiB. Query/body fields use the length, enum, boolean, and pagination limits in `docs/save-history-design.md`.
- The Hono app type is exported through a browser-safe type-only `@silksong-git/history` subpath for later `hono/client` use. The subpath does not import Node, Git, SQLite, watcher, or server runtime code. Runtime API version/capability checks remain required.
- HTTP endpoints are thin Adapters over `packages/history` public Interfaces and do not directly query SQLite, run Git operations, read watcher private fields, or classify errors by message text.
- The history Interface adds `getSaveState`, `readEncodedSave`, and paginated `queryRawObservations`. `queryHistory` drops `includeRawObservations`; Raw Save Observations have a separate result and cursor. `queryHistory`, `queryRawObservations`, and `searchSemanticEvents` support opaque cursor pagination and `asc`/`desc` order; existing Interface/CLI defaults remain `asc`, while HTTP defaults to `desc`, `limit=100`, and a maximum of 1000.
- `getSaveState` supports `latest` and arbitrary observation commit refs. It fixes one canonical immutable commit before reading multiple artifacts, returns `empty` for a valid repository without observations, returns `semanticSnapshot: null` for unrecognized schema, and reports unavailable recognized snapshots rather than silently remapping.
- `readEncodedSave` returns exact committed bytes as `Uint8Array`, the canonical commit and hash, and a safe `<watched-save-stem>.<short-sha>.dat` filename derived from the Watched Save basename only.
- The API exposes authenticated `meta`, watcher status, save state, Semantic Event history, Raw Save Observation history, diff, structured search, manual checkpoint, Encoded Save export, and in-place restore routes exactly as documented in `docs/save-history-design.md`.
- `/meta` reports API name, major/minor version, repository and Watched Save display paths, and stable implementation capabilities. It does not report a placeholder tool version, process instance id, persistent repository UUID, credentials, or transient availability as capabilities.
- Watcher status is polling-only and returns a coarse immutable snapshot with `activity`, `observationRevision`, and the latest compact observation summary. It does not return complete Semantic Events or promise lossless transient-event delivery; Web uses Save State and paginated history after a revision change.
- Manual checkpoint maps committed and skipped results as successes, decode and Watched Save read failures to stable errors, and repository lock timeout to `repository_busy`. The Adapter does not automatically retry POST requests.
- HTTP restore exposes only in-place restore, requires `confirmation: "restore-watched-save"`, and requires a discriminated current-save precondition. History checks the actual Watched Save under `write.lock` before backup or write and returns `restore_conflict` on missing/hash mismatch. Arbitrary server path restore is not exposed.
- Export returns the exact committed `save.dat` body with the content, download, hash, cache, length, and sniffing headers documented in `docs/save-history-design.md`; caller refs and watched directory paths cannot enter the filename or headers.
- Success responses reuse public history DTOs where applicable. Expected Adapter and history failures map to the documented stable HTTP status plus `{ error: { code, message, details? } }`; responses do not expose tokens, request bodies, stack traces, Git stderr, Zod values, or internal absolute paths.
- Expected 4xx responses do not create process events. Known 5xx and unexpected request failures emit sanitized nonfatal `httpRequestError` events. Listener startup has a public classified start error; an unrecoverable listener runtime failure emits fatal reason `httpServerFailure`, gracefully stops the whole process, and releases `watch.lock`.
- Graceful shutdown stops accepting HTTP work and idle connections, waits for handlers already inside public history Interfaces, never hard-cancels a mutation because the client disconnected, finishes watcher work, closes the listener, and releases `watch.lock`.
- Hono, its Node Adapter and Zod validator are direct `packages/history` runtime dependencies and are included in the self-contained CLI bundle. Packed-CLI verification starts authenticated HTTP, calls `meta`, and shuts down cleanly.

Public test seams:

- History Interface with temporary directories, real Git, and real SQLite.
- HTTP Request/Response contract through the Hono Fetch-compatible app, using real history behavior rather than mocks of internal collaborators.
- `startLocalHistoryWatchProcess` with a real `127.0.0.1:0` listener and standard `fetch` for ownership and lifecycle behavior.
- Built CLI process for flags, startup output, signals, and packed-artifact behavior.

TDD Vertical Slices:

- [x] Search can paginate with the existing Semantic Event cursor model
  - Public call: `searchSemanticEvents`.
  - Assert: `limit`, opaque `cursor`, `nextCursor`, and stable order work through the public Interface; changing query/order requires restarting pagination.
- [x] Raw Save Observations have an independent paginated Interface
  - Public call: `queryRawObservations`.
  - Assert: observations paginate independently from Semantic Events in both orders; remove `queryHistory.includeRawObservations` and migrate existing behavior tests.
- [x] Latest Save State reports an empty repository
  - Public call: `getSaveState({ selector: { kind: "latest" } })`.
  - Assert: a valid initialized repository without observations returns `{ status: "empty" }`.
- [x] Save State returns one immutable observation commit
  - Public call: `getSaveState` with latest and explicit commit selectors.
  - Assert: observation, Decoded Save, and Semantic Snapshot all correspond to the same canonical commit, including when a moving ref advances during the composite read.
- [x] Unrecognized Save State remains inspectable
  - Public call: `getSaveState` for an unrecognized observation.
  - Assert: observation and Decoded Save are returned with `semanticSnapshot: null`; recognized state without an available read-model snapshot reports `ReadModelUnavailableError`.
- [x] Encoded Save export data is exact and safely named
  - Public call: `readEncodedSave`.
  - Assert: bytes equal committed `save.dat`, the hash and canonical commit are correct, and the suggested filename contains only a sanitized Watched Save basename stem and short SHA.
- [x] In-place restore rejects a stale current-save precondition
  - Public call: `restoreEncodedSave`.
  - Assert: present-hash and expected-missing mismatches produce `RestoreConflictError` before backup or write; a matching precondition preserves existing backup, write, and verification behavior.
- [x] Authenticated meta is the HTTP tracer bullet
  - Public call: Hono app Request/Response seam.
  - Assert: valid bearer authentication returns the versioned meta contract and capabilities; missing or wrong tokens return indistinguishable `401 unauthorized` responses.
- [x] Standard CORS supports authenticated browser requests
  - Public call: Hono app Request/Response seam.
  - Assert: OPTIONS is the only unauthenticated path, actual routes remain protected, credentials are disabled, and required request/response headers are allowed/exposed.
- [x] HTTP input and error contracts are bounded and stable
  - Public call: Hono app Request/Response seam.
  - Assert: representative strict-Zod, content type, body size, timeout, method, route, cursor, boolean, range, and field-length failures return the documented status/code without leaking unsafe details.
- [x] Save, history, observation, diff, and search GET routes use public Interfaces
  - Public call: authenticated Hono HTTP requests against a real temporary repository.
  - Assert: latest/commit Save State, recent-first paginated histories, diff, and structured search return the documented public results without direct storage assertions.
- [x] Checkpoint route preserves observation semantics
  - Public call: `POST /api/v1/checkpoints`.
  - Assert: committed, unchanged, allow-unchanged, decode failure, read failure, and busy results map to the documented HTTP behavior.
- [x] Export route returns exact bytes and safe headers
  - Public call: `GET /api/v1/export?commit=<ref>`.
  - Assert: body, content headers, ETag, safe basename/short-SHA filename, and authenticated CORS exposure are correct for friendly refs containing Git revision syntax.
- [x] Restore route requires confirmation and optimistic current-save state
  - Public call: `POST /api/v1/restores/in-place`.
  - Assert: strict discriminated input, successful backup/restore, stale-state conflict, repository busy, and restore failure mappings preserve the existing public history behavior.
- [x] Watcher polling exposes compact current state
  - Public call: `GET /api/v1/watcher` through a running Local History Watch Process.
  - Assert: activity is coarse, `observationRevision` increments once per completed observation, multiple observations between polls are detectable, and complete event arrays are not retransmitted.
- [x] Watch process atomically starts watcher and dynamic-port HTTP
  - Public call: `startLocalHistoryWatchProcess({ http: {} })`, then standard `fetch`.
  - Assert: one started event contains actual endpoint/token only after both components are ready, only one watcher owns the repository, and authenticated `meta` is reachable.
- [x] Explicit HTTP port and loopback validation fail safely
  - Public call: `startLocalHistoryWatchProcess` and CLI process.
  - Assert: malformed CLI ports are usage errors; legal occupied ports and invalid configured hosts are classified runtime start failures that clean up the backend and `watch.lock`.
- [x] HTTP runtime failure is process-fatal while request failure is not
  - Public call: running Local History Watch Process.
  - Assert: listener failure emits `httpServerFailure` and stops; a handler 5xx emits sanitized `httpRequestError` and the process remains usable.
- [x] Graceful stop drains active history work
  - Public call: running Local History Watch Process with authenticated requests.
  - Assert: new work and idle connections stop, an entered mutation finishes despite client disconnect or stop signal, watcher work finishes, and `watch.lock` is released.
- [x] CLI reports HTTP credentials exactly once
  - Public call: built CLI in human and `--jsonl` modes.
  - Assert: `--http`, dynamic and explicit ports, `--port` without HTTP, endpoint/token separation, one-time reporting, signal shutdown, and output failure behavior match the documented contract.
- [x] Packed CLI contains the complete HTTP runtime
  - Public call: install the generated CLI tarball, initialize a temporary repository, start `watch --http`, authenticate `meta`, and stop.
  - Assert: no undeclared Hono/Zod runtime dependency is missing and the installed artifact cleans up its watch process.

Verification:

- `pnpm --filter @silksong-git/history test`: passed
- `pnpm --filter @silksong-git/cli test`: passed
- `pnpm --filter @silksong-git/cli verify-pack`: passed; installed the generated tarball, started authenticated HTTP, called `meta`, and stopped cleanly.
- `pnpm verify`: passed

Notes:

- Added the Hono/Zod Request/Response Adapter, browser-safe HTTP contract types, and the authenticated dynamic-port listener owned by the Local History Watch Process.
- Added public history behavior for Save State, exact Encoded Save reads, independent Raw Save Observation pagination, ordered search/history cursors, and restore preconditions.
- CLI bundles the complete HTTP runtime and reports endpoint/token only in the structured started event.

### P5-T8 Generate The Local HTTP OpenAPI Contract

Status: complete

Depends on:

- P5-T7

Owned files or likely files:

- `packages/history/src/http-contract.ts`
- `packages/history/src/http-app.ts`
- `packages/history/src/http-app.test.ts`
- `packages/history/package.json`
- generated Local HTTP OpenAPI documentation

Relevant docs and ADRs:

- `docs/save-history-design.md`
- [ADR-0018](adr/0018-secure-versioned-local-http-adapter.md)

Acceptance criteria:

- OpenAPI-aware Zod route definitions are the runtime source for request validation and generated API documentation.
- The generated OpenAPI 3.1 contract covers every first-version route, Bearer authentication, stable error responses, and the binary export response and headers.
- Existing authentication, CORS, bounded input, error mapping, and public history behavior remain unchanged.
- The browser-safe Hono client type remains available without importing Node, Git, SQLite, or watcher runtime modules.
- A repository command generates an ignored OpenAPI JSON document on demand.

Public test seams:

- Generated OpenAPI document through the public history contract Interface.
- HTTP Request/Response contract through the Hono Fetch-compatible app.

TDD Vertical Slices:

- [x] Generate an OpenAPI 3.1 document for the complete authenticated API contract.
- [x] Drive existing request validation through OpenAPI route definitions without behavior changes.
- [x] Generate the ignored OpenAPI JSON artifact on demand.

Verification:

- `pnpm verify`: passed

Notes:

- Replaced separate Hono request validators with OpenAPI-aware route definitions while preserving the existing authenticated Request/Response behavior.
- Added DTO-aligned response schemas, stable error-code documentation, Bearer security metadata, and binary export response metadata.
- Added `pnpm generate:openapi`; it produces the ignored `docs/generated/local-http-api.openapi.json` artifact on demand.
- Route paths, advertised capabilities, and stable error codes are each declared once and reused by runtime behavior, TypeScript types, and OpenAPI generation.
- `LocalHttpApp` is inferred from the real Hono route registration chain in `http-app.ts` and exposed through a type-only package-root export, removing the separately maintained client route schema without introducing a contract-to-app dependency.

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

### P6-T2 Refactor Web App To Solid

Status: complete

Depends on:

- P6-T1

Owned files or likely files:

- `apps/web/`
- `apps/web/package.json`
- `apps/web/vite.config.ts`
- `apps/web/tsconfig*.json`
- `pnpm-lock.yaml`

Relevant docs and ADRs:

- `docs/current-design-reference/overview.md`
- `docs/current-design-reference/save-to-semantic.md`
- [ADR-0009](adr/0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0011](adr/0011-workspace-package-architecture.md)
- [ADR-0012](adr/0012-core-semantic-module-interface.md)

Acceptance criteria:

- Static Web Mode remains behavior-compatible with the current upload/current-save workflow, without requiring DOM structure or pixel-level equivalence.
- Existing user-visible static behavior remains available: encoded `.dat` and decoded `.json` upload, drag/drop upload, clear data, view switching, missing-only filtering, spoiler display, Act filtering, Raw Save display, summary metrics, mode banner, and map pins.
- The app entry renders through Solid. The old global `DOMContentLoaded` initialization, centralized DOM query module, manual sidebar/tab show-hide path, and module-level save-data globals are removed from the main runtime path.
- Major UI markup moves from `index.html` into the Solid component tree. `index.html` keeps only the app mount point, metadata, and required static links.
- View/tab state is represented by lightweight Solid routing, using a static-deployment-friendly hash route strategy such as `#/progress`, `#/map`, and `#/raw-save`.
- Static deployment compatibility is preserved: `pnpm --filter @silksong-git/web build` produces a pure static Vite SPA, respects the existing `BASE_PATH`/Vite base behavior, and does not require a local HTTP endpoint, CLI process, Node server, or filesystem permission.
- Runtime state has a clear application-owned boundary, split as needed into slices such as `save`, `ui`, and future `localHistory`; components read and write through explicit state/actions/selectors rather than DOM state, scattered module globals, or `localStorage` as the runtime source of truth.
- `localStorage` remains only a persistence adapter for UI preferences such as Act filter, missing-only filter, and spoiler display. But active tab will be dropped and new routing system will handle it.
- Web code continues to use `@silksong-git/core` public Interfaces such as `decodeEncodedSave`, `parseDecodedSave`, `getBuiltinMappingData`, and `createSemanticSnapshot`; it does not copy mapping data, read core internals, or reimplement save-to-semantic mapping.
- Raw Save display may continue to show the raw Decoded Save JSON, while semantic progress and summaries continue to come from Semantic Snapshots.
- Local History Web Mode is not implemented in this task. The task may reserve a state slice or file boundary for future local history work, but it must not probe local HTTP endpoints, call a local history API, or add Current Save, History, Diff, Search, Watcher, Restore, or Export local-history behavior to the runtime path.
- The migration uses minimal Web-scoped dependency changes, expected to include `solid-js`, a Solid-compatible router such as `@solidjs/router`, and any required Vite Solid plugin. It must not perform unrelated root tooling or workspace-wide dependency upgrades.
- Existing CSS and visual language remain the default path. CSS changes are limited to componentization needs or removal of obsolete old-DOM styles; no theme redesign, layout redesign, CSS-in-JS migration, or UI framework migration is included.

Manual QA checklist:

- [x] Visual layout remains approximately equivalent on desktop and mobile, including spacing, fonts, icon rendering, and dark visual language.
- [x] Map zoom and pan feel usable with mouse, touchpad, and representative touch interaction.
- [x] Real browser drag-and-drop upload works, in addition to file-input upload covered by automated tests.
- [x] Clipboard path copy works in a real browser session, including permission behavior for supported browsers.
- [x] Raw Save JSON download creates a usable file through the browser download flow.
- [x] External links such as Wiki, GitHub, and Steam Cloud open as expected.
- [x] Back-to-top, TOC scrolling, modal close behavior, and long-page scrolling feel usable on desktop and mobile.
- [x] Monaco Raw Save display remains usable for representative large save JSON.
- [x] Static build behavior works when served with the GitHub Pages-style `/silksong-git/` base path.
- [x] Representative real user saves, if available locally and not committed, still load and render without obvious regressions.

Verification:

- `pnpm --filter @silksong-git/web test`: passed
- `pnpm verify`: passed

Notes:

- Replaced the old DOM-driven Web runtime with a Solid app rendered from `apps/web/src/main.tsx`.
- `index.html` now keeps only metadata, static links, the app mount point, and the module entry.
- Static Web Mode state is owned by Solid stores for current save data, preferences, and toasts.
- Hash routes now select the Current Save views: `#/progress`, `#/map`, and `#/raw-save`; old active-tab localStorage is not read or written.
- Static save upload continues to route encoded `.dat` and decoded `.json` files through `@silksong-git/core` public Interfaces.
- Progress rendering, summary metrics, Act filtering, missing-only filtering, spoiler preference persistence, item details, Raw Save display, and map pins are covered by Web behavior tests.
- Raw Save uses lazy Monaco initialization in browser runtime and a test fallback for jsdom.
- Local History Web Mode was not implemented and no local HTTP endpoint probing was added.
- Manual QA checklist was not run in a real browser session during this task; browser-only drag/drop, clipboard permission behavior, download flow, touch map interaction, Monaco large-save feel, GitHub Pages-style preview, and representative private user saves remain manual verification items.

### P6-T3 Add Local History Web Mode

Status: in progress

Depends on:

- P5-T7
- P4-T2
- P6-T2

Owned files or likely files:

- `apps/web/`
- `packages/history/` public DTOs and local HTTP API 1.1 contract
- local HTTP client adapter
- local endpoint connection and capability handling
- local history UI views

Relevant docs and ADRs:

- [ADR-0008](adr/0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0009](adr/0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0013](adr/0013-history-module-interface-and-testing.md)
- [ADR-0018](adr/0018-secure-versioned-local-http-adapter.md)

Acceptance criteria:

- Local History Web Mode is enabled by a successful authenticated compatibility handshake from the Topbar connection dialog; there is no separate backend view. Static and Local modes have one active save-state source, credentials remain in page memory, successful connection clears uploaded Static Save state, and disconnect returns to an empty Static `#/progress`.
- The Web client uses the browser-safe Hono client and type-only app contract without importing history server runtime code. It requires local HTTP API 1.1 and the complete documented capability set, ignores unknown additions, rejects malformed required data, and distinguishes authentication or protocol failure from transient endpoint errors without silently discarding already loaded Local state.
- Local History Web Mode preserves the existing Progress, Map, and Raw Save Data views. They use latest Save State by default and share an immutable canonical `commit` URL selection when opened from History. Switching among them preserves selection; a second-row Topbar banner contains Back to Latest and reports newer latest state without replacing the historical selection. Unrecognized observations keep Decoded Save inspectable while semantic views show explicit unavailable states.
- History combines an Events view and an Observations view. Events group Semantic Events by commit; the same list UI calls History with no submitted fields and Search with submitted text/event-kind/target-status/direction fields. Submitted filters, selected view, and pending compare source are URL state; opaque cursor state is not. Both views use recent-first Load More pagination and merge groups across pages.
- History and Search events include their after-Snapshot `SaveSummaryMetrics`; Raw Observation history returns entries pairing an unchanged `RawSaveObservation` with `SaveSummaryMetrics | null`. Commit headers show Completion, Play Time, Rosaries, and Shell Shards without per-commit Save State requests. Filtered events use server-provided visibility and filter reasons.
- Export and Restore are History commit actions rather than independent views. Browser export fetches authenticated Encoded Save bytes and uses the server-provided safe filename. Restore is explicitly confirmed, never automatically retried, normally uses the latest committed observation hash as `expectedCurrent`, and reports unsynchronized Watched Save state as a conflict rather than offering a force override. An explicit missing-file flow uses the server-verified `missing` precondition and warns that no original-file backup exists.
- Diff remains a separate View with canonical from/to refs in the URL and History actions for selecting them. Semantic Diff uses a Progress-style rendering Module with explicit Snapshot/comparison input, defaults to changed items, optionally shows unchanged items, emphasizes returned Semantic Events, and does not mutate the Save Store. A lazy Monaco view compares the two Decoded Save JSON values; it remains available for Unrecognized Schema Observations.
- Watcher status uses visible-page polling and `observationRevision`; revision changes refresh moving latest Save State and merge persistent Semantic Event/Raw Observation pages without disrupting History scroll position. Watcher is not treated as a lossless event stream. Manual Checkpoint belongs to the Watcher view and mutation requests are never automatically retried.
- Local-only URLs remain intact behind a connection-required state after reload or direct navigation. Reconnection resumes the target route, while a normal connection from Static Mode opens latest Progress. Authentication or malformed-protocol failures pause polling and preserve loaded data as stale until reconnect or explicit disconnect.
- New Local History styles use CSS Modules and preserve the existing visual language. The existing Normal and Steel Soul ModeBanner animations are removed; the new interactive historical banner is stable and occupies a second Topbar row only for historical selection.
- The connection UI distinguishes endpoint unavailability, authentication failure, protocol incompatibility, transient history availability, and browser Local Network Access denial. Real-browser smoke tests cover the secure-context permission flow where supported.
- HTTP endpoints are provided by `watch start --http` and are adapters over `packages/history`.
- Web code does not query SQLite or run Git operations directly.
- Frontend serving stays decoupled from the Local History Watch Process; Vite is acceptable for implementation and debugging.

Verification:

- `pnpm --filter @silksong-git/history test`: passed for the local HTTP API 1.1 DTO and browser-safe wire schema slices
- `pnpm --filter @silksong-git/web test DiffView.test.tsx`: passed with 3 tests, including full-width Diff with Progress-owned Semantic TOC layout
- Chromium CDP layout probe at 800×600 and 1440×900: passed with no Progress Legend/TOC overlap
- `pnpm format`: passed after the Progress Legend/TOC overlap fix
- `pnpm verify`: passed after the Progress Legend/TOC overlap fix with 50 Web tests; full P6-T3 acceptance remains pending
- CSS Module migration baseline: `pnpm --filter @silksong-git/web test` passed with 50 tests, `pnpm --filter @silksong-git/web build` passed, and 14 targeted headless-Chromium screenshots covered Static and Local Topbars, Progress, Semantic Diff, Map filters, Upload, and Raw Save at 800×600 and 1440×900
- Legacy CSS cleanup: `pnpm --filter @silksong-git/web test` passed with 50 tests, `pnpm --filter @silksong-git/web build` passed, `pnpm exec prettier --check apps/web/public/assets/css/style.css` passed, and `git diff --check` passed
- Banner CSS Module migration: `pnpm --filter @silksong-git/web test App.test.tsx` passed with 22 tests, the full Web suite passed with 50 tests, the Web production build passed, and Stylelint passed for the global and two banner stylesheets; Chromium checks at 800×600 and 1440×900 covered hidden, Normal, and Steel Soul states, with the Normal Topbar matching its migration baseline pixel-for-pixel
- CSS Module lint coverage: a temporary invalid Module proved the previous `pnpm lint apps/web` path missed `src/**/*.css`; after expanding the shared Stylelint command, both `pnpm lint apps/web` and full `pnpm lint` passed while checking every first-party Web CSS file
- Leaf CSS Module migration: `CI=1 pnpm --filter @silksong-git/web test` passed with 51 tests, `CI=1 pnpm format` passed, and `CI=1 pnpm verify` passed; Chromium checks at 800×600 and 1440×900 covered Upload and Raw Save, with the 1440×900 Upload panel differing from its baseline by only 56 antialiased pixels
- local Web UI smoke test: pending

Notes:

- Completed the `packages/history` API 1.1 prerequisite: History, Search, Diff, and incremental events include after-Snapshot summary metrics; Raw Observation history returns summary-bearing entries with explicit `null` for Unrecognized Schema Observations.
- The local HTTP meta, runtime schemas, and generated OpenAPI contract now describe API 1.1. Local History Web Mode implementation in `apps/web` remains part of this in-progress task.
- Removed the legacy Normal and Steel Soul `ModeBanner` blink animations as a CSS-only polish change; no dedicated behavior test was added.
- Diff Raw JSON now loads both selected Decoded Saves independently from Semantic Diff and renders them through a lazy Monaco diff viewer; the jsdom fallback keeps both formatted JSON values inspectable, including Unrecognized Schema Observations.
- Removed the unused `categoryId` from Semantic Snapshots, Semantic Events, the Local History wire contract, and the rebuildable read-model schema. Builtin mapping categories never provided that identifier, and no Web rendering or history query behavior consumed it; requiring it only caused valid rebuilt Save State responses to fail client protocol validation.
- History Events Load More keeps opaque cursors in component state, appends older results without hiding the existing list, and groups the combined event pages so a commit split at a cursor boundary remains one card.
- Raw Save Observations has independent cursor state and Load More behavior, so switching History views cannot reuse an Events cursor; appending older entries also keeps the existing Observation list visible.
- Connected Local History session availability is explicit: later request failures retain the authenticated session and already displayed Local Save as stale, while authentication, incompatibility, and malformed-protocol failures are classified to pause automatic requests.
- `LocalHistoryRuntime` owns one visibility-aware Watcher polling loop; the Local session Interface exposes the latest validated Watcher status and its `observationRevision` without making Views own timers or transport state.
- Watcher revision changes refresh a session-owned moving latest Save State; the shared Save Store follows that source only without a selected `commit`, so an in-flight refresh cannot replace an immutable historical selection.
- Manual Checkpoint response validation uses a wire union rather than a `status`-discriminated union because both unchanged and minimum-interval results intentionally share `status: "skipped"`; the public DTO and HTTP response shapes remain unchanged.
- History-to-Diff navigation previously left canonical `from` and `to` refs out of the form because `DiffView` read `globalThis.location.hash` before the browser hash synchronized during a HashRouter transition; reading the Router-owned `location.search` fixes both inputs while keeping the URL contract unchanged.
- `AppShell` is width-neutral; `ProgressSnapshotView` owns its content/TOC grid, bottom-sticky Legend, and sticky TOC placement so both standalone Progress and embedded Semantic Diff render correctly without overlay overlap, while Raw JSON Diff uses the full route width and a shared explicitly sized Monaco frame.
- CSS Module migration preparation captured the current rendered UI before changing style ownership. The screenshots are temporary local review artifacts rather than committed fixtures; they intentionally preserve existing compact-layout behavior instead of treating it as a new acceptance standard.
- Removed 634 lines of confirmed-unreferenced Home/Cinematic, legacy Progress-container, Raw Save search, Map loading, and miscellaneous CSS from `apps/web/public/assets/css/style.css`, reducing it from 2,828 to 2,195 lines without migrating a component. Mixed selectors retained their active branches, including `.sidebar-links`, `main a`, `.info-link`, `.main-section-block`, `.grid`, and `.category-description`.
- `ModeBanner` and `HistoricalSelectionBanner` now own separate CSS Modules. `id="modeBanner"` remains only as a DOM Interface, module state classes own hidden and Steel Soul presentation, and the corresponding global ID rules and mixed `SaveBanner.module.css` ownership were removed without changing the rendered Normal Topbar.
- Full and `apps/web`-scoped lint now share one Stylelint target covering `apps/web/src/**/*.css` plus the remaining first-party global stylesheet. The CSS Module override recognizes `:global(...)` and defers isolated-file unknown-custom-property checks because theme tokens are declared by the global stylesheet; all other Stylelint rules remain active for Modules.
- `BackToTop`, `RawSaveView`, `UploadModal`, and `PreferenceControls` now own their feature styles. Visibility and expansion use native `hidden` plus semantic ARIA state, Raw Save leaves editor internals with `MonacoViewer.module.css`, and the still-global InfoModal overlay/panel rules were narrowed to its stable IDs until Step 5 migrates that component.

CSS Module migration checklist:

- [x] Step 2: finish the partially modularized banner styles.
  - [x] Move `ModeBanner` base, `hidden`, `steel`, and icon styles into `ModeBanner.module.css`; use module state classes while retaining `id="modeBanner"` only as a DOM Interface.
  - [x] Give `HistoricalSelectionBanner` its own Module instead of sharing mixed ownership through `SaveBanner.module.css`.
  - [x] Remove the corresponding global `#modeBanner` rules and verify Static, Local, Normal, Steel Soul, and historical-selection Topbar states.
- [x] Step 3: migrate independent leaf Modules in order.
  - [x] Migrate `BackToTop`, expressing visibility through conditional rendering, `hidden`, or a module state class.
  - [x] Migrate `RawSaveView` while keeping editor internals owned by `MonacoViewer.module.css`.
  - [x] Migrate `UploadModal`, including overlay, panel, dropzone, drag state, help, platforms, and pills; do not extract a shared Dialog Module yet.
  - [x] Migrate `PreferenceControls`, replacing global dropdown/toggle/checkbox styles and the global `.hidden` dependency with local state and `aria-expanded`/`hidden` behavior.
- [ ] Step 4: migrate the Map cluster in dependency order.
  - [ ] Migrate `InteractiveMapCanvas`, including page/modal variants, stage, image, pins, markers, and obtained state; expose stable `data-variant` or semantic DOM state for tests.
  - [ ] Migrate `MapFiltersPanel`, including collapsed/open state, search, filter controls, and filter items; expose expansion through `aria-expanded`.
  - [ ] Migrate `MapView` page layout and map selector controls.
  - [ ] Keep `InfoModal` dependent only on the public `InteractiveMapCanvas` Interface, not its internal class names.
- [ ] Step 5: migrate the Progress cluster in order.
  - [ ] Migrate `ProgressItemCard`, moving card, item status, spoiler state, Act label, special icons, journal counter, and diff-change styles into its own Module.
  - [ ] Replace test dependencies on `.boss`, `.done`, `.locked`, and related style classes with explicit `data-status`, `data-spoiler-state`, and existing semantic attributes; remove the `body.spoiler-on` side effect.
  - [ ] Migrate `ProgressLegend`, preserving its existing `aria-expanded` Interface.
  - [ ] Migrate `ProgressToc`, replacing global `open`, `active`, and `hidden` classes with module state plus `aria-expanded`, `aria-current`, and `hidden` behavior.
  - [ ] Migrate `ProgressSection`, retaining heading IDs only for the TOC scroll Interface.
  - [ ] Reduce `ProgressSnapshotView.module.css` to page-level layout, stats, and Diff toolbar ownership; remove its `:global(...)` selectors.
  - [ ] Migrate `InfoModal`, including its item content, journal presentation, map wrapper, and link styles.
- [ ] Step 6: migrate the application shell after its children are stable.
  - [ ] Migrate `Sidebar`, including responsive layout and active navigation state; expose route selection through link semantics such as `aria-current`.
  - [ ] Migrate `Topbar`, limiting it to primary-row, right-controls, and historical second-row layout without styling child internals.
  - [ ] Migrate `AppShell`, including `main-wrapper`, `main`, scrollbars, and responsive layout; verify every route after removing global element-level layout rules.
- [ ] Step 7: consolidate real shared styles and close the global stylesheet.
  - [ ] Move shared primary, danger/reset, secondary, and small button variants into one `Button.module.css` without introducing a speculative component wrapper.
  - [ ] Compare Upload, Info, and Local Connection dialogs; extract only overlay/panel/close styles that demonstrably change together into a shared Dialog Module.
  - [ ] Move the remaining fonts, theme tokens, `html`/`body` reset, cursor, `button { font: inherit }`, and minimal element defaults into `apps/web/src/app/global.css`, imported by `main.tsx`.
  - [ ] Remove the public `style.css` link and delete the global `.hidden`, feature ID selectors, broad `main a !important` overrides, feature descendant selectors, and all migrated class rules.
- [ ] Close out the migration.
  - [ ] Run the narrow Web tests after every vertical slice, then run `pnpm format` and `pnpm verify` before commit.
  - [ ] Repeat the 800×600 and 1440×900 Chromium checks for Progress, Semantic Diff, Map, Upload, Raw Save, Static/Local Topbars, and dialog layering against the migration baseline.
  - [ ] Confirm tests use semantic DOM Interfaces rather than CSS Module hashes and that no feature or shell style remains in the global stylesheet.

TDD vertical slices:

- [x] Raw Save Observations uses its own recent-first opaque cursor; Load More appends older entries independently from History Events pagination.
- [x] History Events uses recent-first opaque cursor pagination; Load More appends older events and merges commit groups that cross page boundaries.
- [x] Remove the unused Semantic Snapshot/Event `categoryId` field across core and Local History contracts so rebuilt Save State responses validate without synthetic category identifiers.
- [x] `ProgressSnapshotView` accepts an explicit Semantic Snapshot; `ProgressView` delegates to it, and Progress sections, items, and TOC render through its private context rather than the application Save Store.
- [x] `LocalHistoryClient` reads authenticated `/api/v1/meta` responses through the browser-safe wire schemas, accepts unknown capabilities, validates compatibility, and classifies authentication failures without automatic retry.
- [x] All Local History endpoint request/response schemas live in the browser-safe `http-wire` module; `http-contract` only decorates those schemas for OpenAPI route registration.
- [x] `LocalHistoryProvider` establishes an in-memory authenticated compatibility session through the Topbar connection dialog; a successful connection clears Static Save state and returns to latest Progress.
- [x] Connected Local History mode hides the Static Save upload/reset controls while preserving them for disconnected Static Web Mode.
- [x] Connected Local History loads and renders the latest Save State through `LocalHistoryClient`, `LocalHistoryRuntime`, and the explicit SaveStore Local source seam.
- [x] Local-only History, Diff, and Watcher routes preserve direct URLs behind a connection-required state; selected commit URLs load through the same Current Save routes and expose a stable Back to Latest banner.
- [x] History Events and Observations views use one search form, selecting `/history` with no submitted fields and `/search` for submitted text while retaining a Local-only connection boundary.
- [x] Semantic Diff defaults to changed items, optionally shows unchanged items, and highlights returned item changes through the Progress-style rendering seam.
- [x] Diff Raw JSON compares the selected `from` and `to` Decoded Saves through a lazy Monaco diff viewer, including Unrecognized Schema Observations.

Local session/runtime slices:

- [x] Classify Local History connection and polling failures while preserving already loaded data as stale; authentication and protocol failures pause automatic requests until reconnect or disconnect.
- [x] `LocalHistoryRuntime` polls Watcher status only while the document is visible and exposes the latest Watcher snapshot and `observationRevision` through the Local session Interface.
- [x] A Watcher revision change refreshes a moving latest Save State without replacing an explicitly selected historical commit.
- [x] Historical selection reports when a newer latest observation exists and Back to Latest switches the shared Current Save views to that moving source.
- [x] The connection UI distinguishes Local Network Access denial from endpoint unavailability, authentication failure, protocol incompatibility, and transient history availability.

History slices:

- [x] The History search form submits free text, event kind, target status, direction, and `includeFiltered`; submitted fields live in the URL, choose `/search`, and reset the in-memory Events cursor, while an empty search uses `/history`.
- [x] Direct navigation or reconnection restores the History view and submitted filters from the URL, loading Observations immediately for `view=observations` instead of unconditionally loading Events.
- [x] Events query state is owned by a feature-local Module that keeps `/history` versus `/search` selection, opaque pagination, cross-page commit grouping, and revision refresh behind one Interface.
- [x] Raw Save Observation query state is owned by an independent feature-local Module that keeps its opaque pagination and revision refresh behind one Interface.
- [x] Events and Observations reuse one commit-card Module that displays schema availability plus Completion, Play Time, Rosaries, and Shell Shards and exposes the applicable commit actions.
- [x] History Compare selection stores `compareFrom` in the URL and selecting a target commit opens Diff with canonical `from` and `to` refs.
- [x] History Export downloads authenticated Encoded Save bytes with the server-provided filename, revokes its browser object URL, preserves selection, and reports failures.
- [x] Normal History Restore uses the latest committed observation hash as the `present` precondition, reports synchronization conflicts, and never offers a force override or automatic retry.
- [x] An explicit missing-Watched-Save Restore flow sends the server-verified `missing` precondition and warns that no original-file backup can be created.
- [x] Watcher revision refresh merges persistent Events and Raw Save Observations into already paginated History state without disrupting the current scroll position.

Diff slices:

- [x] Diff keeps canonical `from` and `to` refs in the URL and exposes Semantic and Raw JSON views as explicit tabs.
- [x] Diff loads Semantic comparison and both Decoded Saves independently so one failed data source does not discard the other result.
- [x] Unrecognized Schema Observations show an explicit Semantic Diff unavailable state while retaining the lazy Monaco Decoded Save JSON comparison.

Watcher slices:

- [x] Watcher renders the Runtime-owned status snapshot, including activity, Watched Save path, Capture Policy, latest observation, and Watcher Error state, without starting a second polling loop.
- [x] Watcher Manual Checkpoint submits an optional message once and renders committed, skipped, and Watcher Error results without automatic retry.
- [x] Watcher Manual Checkpoint exposes explicit `allowUnchanged` intent while preserving the same single-submit behavior.

Closeout-found fix slices:

- [x] History-to-Diff navigation reads Router-owned search state so canonical `from` and `to` refs populate the Diff form after an in-app transition.
- [x] Raw JSON Diff uses a shared explicitly sized Monaco frame, while width-neutral App shell layout and a Progress-owned sticky TOC grid keep both Raw and Semantic Diff layouts intact.

P6-T3 closeout review:

- [ ] Real-browser smoke testing covers Local Network Access permission behavior, authenticated Export, Restore confirmation/conflict, reconnection, visible-page polling, and historical selection.
- [ ] Static Web Mode and the existing Progress, Map, and Raw Save Data workflows pass regression testing after Local History completion.
- [ ] A final standards/spec review finds no remaining P6-T3 acceptance gaps; full validation passes and P6-T3 is marked complete.

### P6-T4 Add UI Open CLI Workflow

Status: pending

Depends on:

- P6-T3

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
- [ADR-0018](adr/0018-secure-versioned-local-http-adapter.md)

Acceptance criteria:

- UI open behavior matches `docs/save-history-design.md`; that document remains the source for concrete command grammar and flags.
- The command opens or serves the Web UI client without becoming a second history writer.
- Local endpoint discovery or connection behavior is explicit and compatible with Local History Web Mode.
- Endpoint and token remain separate values; credentials are not placed in a URL, persisted to Project Config, or exposed to frontend serving infrastructure. The exact browser handoff UX must preserve the one-process, per-start token model from ADR-0018.
- The command does not make Web code call Git, SQLite, watcher, or history internals directly.

Verification:

- `pnpm verify`: pending
- Relevant test or smoke command: pending
