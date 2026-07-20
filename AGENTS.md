# Agent and Maintainer Instructions

This file is the working entry point for AI agents and maintainers. `README.md` is user-facing and should not be treated as the architecture source of truth.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See the
[issue tracker rules](docs/agents/issue-tracker.md).

### Triage labels

The tracker uses the canonical
[triage label vocabulary](docs/agents/triage-labels.md).

### Domain docs

This repository uses a
[single-context domain documentation layout](docs/agents/domain.md).

## Work Intake

- Use `triage` for an incoming or uncertain request.
- Use `wayfinder` when the destination is large and the route is unclear.
- Use `to-spec`, then `to-tickets`, when the outcome is clear but implementation
  requires multiple agent sessions.
- For a small maintainer-approved feature or reproducible bug, create one
  executable ticket directly.

## Documentation Map

Start with the [documentation map](docs/README.md). It maps each kind of project
knowledge to its authoritative source.

The current authoritative sources are:

| Source                             | Owns                                                  | Update When                                                     |
| ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| [`docs/README.md`](docs/README.md) | Documentation navigation and authority map.           | A document role or authority boundary changes.                  |
| [`CONTEXT.md`](CONTEXT.md)         | Domain vocabulary.                                    | A domain term is settled or renamed.                            |
| `docs/architecture/`               | Current system and Module ownership and invariants.   | Implemented architecture or a current boundary changes.         |
| `docs/adr/`                        | Accepted decisions and rationale.                     | A decision is accepted, superseded, or replaced.                |
| `docs/reference/`                  | CLI and Local HTTP user/integration contracts.        | User-facing or wire behavior changes.                           |
| Package-root exports and tests     | Exact public TypeScript Interfaces and behavior.      | A callable contract or its behavior changes.                    |
| GitHub specs and tickets           | Intended outcomes, active work, blockers, and claims. | Scope, acceptance, dependencies, or execution state changes.    |
| `docs/legacy/`                     | Preserved historical behavior and migration evidence. | Historical compatibility evidence is clarified or reclassified. |

Before architecture, refactor, CLI, history, or semantic-mapping work, read
`docs/README.md`, `CONTEXT.md`, and the relevant ADRs, then follow the current
authority link for the area. Read legacy references only when preserving or
explaining historical behavior.

Do not duplicate large parts of these documents into new files. Link to them and update the authoritative document when decisions change.

## Execution Tracking

Use GitHub Issues as the task backlog and progress tracker. Start from the global
frontier and follow the [issue tracker rules](docs/agents/issue-tracker.md).

Before starting implementation work:

- Fetch the ticket, comments, labels, assignee, and blocking relationships.
- Pick an open, unassigned task whose dependencies are complete, then claim it.
- Keep the task's owned files and acceptance criteria in mind.
- When the task is done, record durable changes in the repository and update
  the ticket's checklist, verification evidence, and state.

Before implementation, record intended outcomes, scope, acceptance criteria,
blocking edges, and claims in GitHub. Update `CONTEXT.md` or an ADR when a domain
term or durable decision is settled. Update Architecture and Reference only with
implemented behavior; do not describe planned behavior as current.

Do not rely on chat history for project state. Record changing delivery state
in GitHub; commits, pull requests, and CI own implementation and verification
history.

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

`pnpm format` applies formatting and lint fixes, taking about 40s. `pnpm verify` then runs linting, tests, builds, and custom verifications, taking more than 60s.

If satisfying the linter would conflict with the design or degrade code quality, pause the work and report.

If only `*.md` files changed, `pnpm verify` may be skipped; run `pnpm format <changed-markdown-files...>` so formatting is limited to the modified files.

If validation fails because of unrelated local files or pre-existing issues, report the exact failing paths and checks.
