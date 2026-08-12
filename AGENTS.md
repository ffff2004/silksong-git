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

## Documentation Map

Start with the [documentation map](docs/README.md). It owns the classification,
authority, and update rules for every kind of project knowledge.

Before architecture, refactor, CLI, history, or semantic-mapping work, read
`docs/README.md`, `CONTEXT.md`, and the relevant ADRs, then follow the current
authority link for the area. Read legacy references only when preserving or
explaining historical behavior.

Do not duplicate authoritative content into new files. Link to it and update the
owning source when durable knowledge changes.

## Execution Tracking

GitHub Issues is the sole authority for intended outcomes, active work,
dependencies, claims, and execution state.

Before implementation, start from the global frontier and follow the complete
[issue tracker lifecycle](docs/agents/issue-tracker.md#implementation-lifecycle).

Do not rely on chat history for project state. Record changing delivery state
in GitHub; commits, issues and pull requests own implementation and verification
history.

## Architecture Guardrails

- Keep the semantic core free of DOM, Git, SQLite, filesystem watching, and HTTP concerns.
- Keep history persistence as the owner of Git, SQLite, watcher leases, and restore. Keep Repo Session as the owner of watcher scheduling and local HTTP lifecycle.
- Web frontend code must use local HTTP endpoints for local-history workflows and must not directly call Git, SQLite, filesystem watcher, or history internals.
- Web, CLI, and HTTP adapters must call public package Interfaces rather than internal helpers, SQLite tables, or Git command details.
- Display Semantic Event Filters affect query/display behavior only; they must not decide raw Git commits or delete events from SQLite.

## Test Strategy

Tests should verify behavior through public Interfaces:

- `packages/core` tests use `createSemanticSnapshot` and `diffSemanticSnapshots`.
- `packages/history` tests use the history Interface with temporary directories, real Git, and real SQLite.
- `packages/repo-session` runtime behavior tests use the root Repo Session Interface with real History repositories and loopback HTTP. Tests for `./http-wire` and `./http-contract` may call those public contract subpaths directly.
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
- Use a code comment for local, non-obvious implementation constraints near the code (explain why, not what).

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
pnpm verify:agent
```

`pnpm format` applies formatting and lint fixes, taking about 55s. `pnpm verify:agent` then runs linting, tests, builds, and custom verifications, taking more than 150s.

If satisfying the linter would conflict with the design or degrade code quality, pause the work and report.

If only `*.md` files changed, `pnpm verify:agent` may be skipped; run `pnpm format` instead.

If validation fails because of unrelated local files or pre-existing issues, report the exact failing paths and checks.
