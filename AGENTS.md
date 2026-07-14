# Agent and Maintainer Instructions

This file is the working entry point for AI agents and maintainers. `README.md` is user-facing and should not be treated as the architecture source of truth.

## Documentation Map

Use these documents as the working entry points:

| Document                                    | Purpose                                                        | Update When                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docs/save-history-design.md`               | Implementation map for the planned save-history fork.          | Architecture or implementation guidance changes.                                                            |
| `docs/implementation-plan.md`               | Task backlog, phase order, dependencies, and progress tracker. | Task status, dependencies, acceptance criteria, or verification results change.                             |
| `CONTEXT.md`                                | Domain vocabulary. Use these terms consistently.               | A domain term is settled or renamed.                                                                        |
| `docs/adr/`                                 | Accepted decisions and rationale.                              | A hard-to-reverse design decision is accepted.                                                              |
| `docs/current-design-reference/overview.md` | Current Web app overview and preserved static behavior.        | Current Web UI behavior or package location is clarified or corrected; not for future architecture changes. |

Before architecture, refactor, CLI, history, or semantic-mapping work, read `docs/save-history-design.md`, `CONTEXT.md`, and the relevant ADRs. Read current-design references when extracting or preserving current behavior.

Do not duplicate large parts of these documents into new files. Link to them and update the authoritative document when decisions change.

## Execution Tracking

Use `docs/implementation-plan.md` as the task backlog and progress tracker.

Before starting implementation work:

- Read the current phase and task status in `docs/implementation-plan.md`.
- Pick a task whose dependencies are complete.
- Keep the task's owned files and acceptance criteria in mind.
- When the task is done, update its status and verification results in `docs/implementation-plan.md`.

Do not rely on chat history for project state. If progress, dependencies, or task status changes, record it in `docs/implementation-plan.md`.

## Architecture Guardrails

- Keep the semantic core free of DOM, Git, SQLite, filesystem watching, and HTTP concerns.
- Keep history persistence as the owner of Git, SQLite, watcher, restore, and Local History Watch Process behavior.
- Web frontend code must use local HTTP endpoints for local-history workflows and must not directly call Git, SQLite, filesystem watcher, or history internals.
- Web, CLI, and HTTP adapters must call public package Interfaces rather than internal helpers, SQLite tables, or Git command details.
- Display Semantic Event Filters affect query/display behavior only; they must not decide raw Git commits or delete events from SQLite.

## TDD Strategy

Follow `tdd` skill. Use vertical slices, not horizontal batches. One behavior test should go red, then implementation should make it green, then move to the next behavior.

Tests should verify behavior through public Interfaces:

- `packages/core` tests use `createSemanticSnapshot` and `diffSemanticSnapshots`.
- `packages/history` tests use the history Interface with temporary directories, real Git, and real SQLite.
- Mocks are limited to true system boundaries such as time and watcher event delivery.
- Tests should not assert internal helper calls, Git command calls, or SQLite table layout.

## Commit Messages

Use Conventional Commits:

```txt
<type>(<scope>): <summary>
```

Common types include `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, and `build`.

Use the special type `agents` when the primary purpose is changing agent-facing instructions or assets, such as `AGENTS.md`, `.agents/`, `.agents/skills/`, handoff notes, or workflow guidance for agents.

Examples:

```txt
agents: clarify validation order
agents(skills): update save-history workflow guidance
docs: add save history design
refactor(core): extract semantic snapshot creation
```

If a change touches `AGENTS.md` as a secondary part of code or architecture work, choose the type for the primary purpose instead of `agents`.

Use a multi-line commit message when a change spans multiple Modules or when the reason is not obvious from the diff:

```txt
refactor(core,web): route current save rendering through semantic snapshots

Move the existing Web UI save interpretation behind the core semantic
Interface so CLI and Web can share the same behavior.

This preserves current static upload behavior while creating the seam needed
for history snapshots in later changes.
```

Choose the right place for explanation:

- Use the commit body to explain why this commit makes this change now.
- Use an ADR for long-lived design decisions, trade-offs, rejected alternatives, or constraints future work must preserve.
- Use a code comment for local, non-obvious implementation constraints near the code.

When both an ADR and a commit body are needed, the ADR records the durable decision and the commit body explains how this commit applies it.

## Validation

During implementation, prefer the narrowest relevant package test for fast behavioral feedback:

```sh
pnpm --filter <changed-package> test
```

Expand to dependent packages or full `pnpm test` when a change affects shared Interfaces, cross-package behavior, root tooling, fixtures, or integration paths.

Do not run `pnpm --filter <changed-package> format/lint`, since the root validation sequence covers formatting and cross-package linting.

Before commit, run formatting and full repository verification serially, in this order:

```sh
pnpm format
pnpm verify
```

`pnpm format` applies formatting and lint fixes. `pnpm verify` then runs linting, tests, builds, and custom verifications. It takes more than 90 seconds.

If only `*.md` files changed, `pnpm verify` may be skipped; run `pnpm format <changed-markdown-files...>` so formatting is limited to the modified files.

If validation fails because of unrelated local files or pre-existing issues, report the exact failing paths and checks.
