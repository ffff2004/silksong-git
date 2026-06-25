# Implementation Plan

This document is the execution tracker for the save-history fork. It records phase order, task dependencies, current progress, acceptance criteria, and verification results so future agents can continue without chat history.

For architecture and rationale, read `docs/save-history-design.md`, `CONTEXT.md`, and the relevant ADRs. This document should not repeat their design detail.

## Current Status

- Current phase: P3 Core Semantic Module
- Next task: P3-T2 Core Snapshot Current Mapping Coverage
- Last updated: 2026-06-25

## Phase Overview

| Phase                                 | Status      | Depends On | Goal                                                                                       |
| ------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------ |
| P1 Documentation / Repository Hygiene | complete    | none       | Documentation is coherent, old references are moved, and validation passes.                |
| P2 Workspace Skeleton                 | complete    | P1         | pnpm workspace exists while existing Web behavior remains unchanged.                       |
| P3 Core Semantic Module               | in progress | P2         | `packages/core` exposes snapshot and diff behavior through a small public Interface.       |
| P4 History Module                     | pending     | P3         | Raw observations, restore, and SQLite Semantic Read Model work through `packages/history`. |
| P5 CLI                                | pending     | P3, P4     | First object-grouped CLI command set works through core/history Interfaces.                |
| P6 Web Integration                    | pending     | P3, P4     | Web UI uses core and supports static and local history modes.                              |

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
- ADR-0011

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
- ADR-0012
- ADR-0017

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

Status: in progress

Depends on:

- P3-T1

Owned files or likely files:

- `packages/core/`
- core snapshot tests and fixtures
- mapping data imports or copies from `apps/web/src/data/*.json`

Relevant docs and ADRs:

- ADR-0003
- ADR-0012
- ADR-0015
- ADR-0017
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
- [ ] Direct `playerData` booleans map to semantic item status.
- [ ] Key flags map to semantic item status.
- [ ] Numeric thresholds map to semantic item status.
- [ ] `savedData` quantity and unlocked entries map to semantic item status.
- [ ] Quest states map to semantic item status.
- [ ] Journal progress maps to semantic item status.
- [ ] Relic, materium, and device states map to semantic item status.
- [ ] `sceneVisited` entries map to semantic item status.
- [ ] `quill` entries map to semantic item status.
- [ ] `anyOf` entries map to semantic item status.
- [ ] Special scene numeric branch supports Shell Fossil Mimic-style entries.
- [ ] Built-in mapping data smoke coverage verifies `getBuiltinMappingData`.

Latest slice verification:

- `sceneBool` missing item: `pnpm --filter @silksong-git/core test`: passed
- `pnpm format`: passed
- `pnpm lint`: passed

Review follow-ups:

- Semantic Snapshot Version Stamps include `saveSchemaVersion`, `gameVersion`, `platform`, `platformBuildId`, `mappingDataVersion`, `semanticCoreVersion`, and `configHash`.
- Save Summary Metrics use semantic names in `packages/core`: raw `geo` maps to `rosaries`, and raw `ShellShards` maps to `shellShards`.

Verification:

- core test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

### P3-T3 Core Semantic Diff

Status: pending

Depends on:

- P3-T2

Owned files or likely files:

- `packages/core/`
- semantic diff tests and fixtures

Relevant docs and ADRs:

- ADR-0002
- ADR-0003
- ADR-0014
- ADR-0015

Acceptance criteria:

- Two Semantic Snapshots produce item-level Semantic Events.
- Numeric threshold, stage, summary metric, and regression rules are represented according to ADR-0014.
- Tests use `diffSemanticSnapshots`.

Verification:

- core test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

### P3-T4 Define Autonomous Commit Policy

Status: pending

Depends on:

- P3-T1

Owned files or likely files:

- `AGENTS.md`
- `docs/implementation-plan.md`

Relevant docs and ADRs:

- `AGENTS.md`
- `docs/implementation-plan.md`
- `CONTEXT.md`
- TDD skill guidance

Acceptance criteria:

- Decide whether agents may commit without an extra user confirmation after a clear, approved, green TDD vertical slice.
- If accepted, add an `AGENTS.md` rule describing when autonomous commits are allowed and forbidden.
- The rule must preserve TDD planning constraints: public Interface changes and prioritized behaviors need prior user or documented approval.
- The rule must forbid autonomous commits for RED tests, failed validation, unrelated user changes, unapproved public Interface changes, unrecorded architecture decisions, ambiguous tasks, and temporary checkpoints.
- The rule must say documentation and `docs/implementation-plan.md` are updated before committing when task status, verification, or design guidance changes.

Verification:

- `pnpm format`: pending
- `pnpm lint`: pending

## P4 History Module

### P4-T1 Raw Observation Restore Tracer Bullet

Status: pending

Depends on:

- P3-T2

Owned files or likely files:

- `packages/history/`
- history integration tests

Relevant docs and ADRs:

- ADR-0001
- ADR-0005
- ADR-0006
- ADR-0007
- ADR-0013
- ADR-0016

Acceptance criteria:

- `initSaveHistory` creates a single-save Save History Repository.
- `observeSave` commits `save.dat`, `decoded-save.json`, and `observation.json`.
- `restoreEncodedSave` restores bytes equal to the observed Encoded Save.
- Tests use temporary directories, real Git, and real SQLite where practical.

Verification:

- history test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

### P4-T2 Rebuild And Query Semantic Read Model

Status: pending

Depends on:

- P4-T1
- P3-T3

Owned files or likely files:

- `packages/history/`
- SQLite read model implementation and migrations
- history integration tests

Relevant docs and ADRs:

- ADR-0001
- ADR-0008
- ADR-0013
- ADR-0015

Acceptance criteria:

- `rebuildSemanticReadModel` rebuilds SQLite from raw observation commits.
- `queryHistory`, `diffCommits`, and `searchSemanticEvents` work through the history Interface.
- SQLite schema remains private to `packages/history`.

Verification:

- history test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

## P5 CLI

### P5-T1 Implement `save snapshot --save --json`

Status: pending

Depends on:

- P3-T2

Owned files or likely files:

- `apps/cli/`
- CLI tests

Relevant docs and ADRs:

- ADR-0010
- ADR-0012

Acceptance criteria:

- `save snapshot --save <path> --json` prints a Semantic Snapshot.
- Command syntax matches `docs/save-history-design.md`.
- Decode failure exits 2.
- Unknown schema exits 3 by default and supports raw debugging behavior as designed.
- Output JSON is stable enough for tests.

Verification:

- CLI test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

### P5-T2 Implement History CLI Commands

Status: pending

Depends on:

- P4-T2

Owned files or likely files:

- `apps/cli/`
- CLI tests

Relevant docs and ADRs:

- ADR-0010
- ADR-0013

Acceptance criteria:

- First-version object-grouped command set matches `docs/save-history-design.md`.
- Commands call `packages/history` rather than Git or SQLite directly.
- `history list`, `history diff`, and `history search` default to readable text and support stable `--json`.
- Repository-scoped commands follow the documented repo context resolution order.

Verification:

- CLI test command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

## P6 Web Integration

### P6-T1 Route Current Save Flow Through Core

Status: pending

Depends on:

- P3-T2

Owned files or likely files:

- `apps/web/`
- current Web UI tests or smoke checks

Relevant docs and ADRs:

- `docs/current-design-reference/overview.md`
- `docs/current-design-reference/save-to-semantic.md`
- ADR-0009
- ADR-0012

Acceptance criteria:

- Static Web Mode preserves the existing upload/current-save behavior.
- Current save rendering uses `packages/core` instead of duplicated mapping logic.
- User-visible behavior is unchanged.

Verification:

- Web test/build command: pending
- `pnpm format`: pending
- `pnpm lint`: pending

### P6-T2 Add Local History Web Mode

Status: pending

Depends on:

- P4-T2
- P6-T1

Owned files or likely files:

- `apps/web/`
- local HTTP adapter
- local history UI views

Relevant docs and ADRs:

- ADR-0008
- ADR-0009
- ADR-0013

Acceptance criteria:

- Local History Web Mode shows Current Save, History, Diff, Search, Watcher, and Restore/Export views.
- HTTP endpoints are adapters over `packages/history`.
- Web code does not query SQLite or run Git operations directly.

Verification:

- Web test/build command: pending
- local UI smoke test: pending
- `pnpm format`: pending
- `pnpm lint`: pending
