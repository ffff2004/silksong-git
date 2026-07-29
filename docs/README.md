# Project Documentation

This is the navigation and authority entry point for project knowledge. It
separates durable domain and architecture knowledge from executable contracts,
delivery state, and preserved legacy behavior.

## Authority Map

| Knowledge                                     | Authority                                                                                                                                                                                                                             | Update When                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Documentation navigation and authority rules  | This document                                                                                                                                                                                                                         | A document role or authority boundary changes.                  |
| Domain vocabulary                             | [`CONTEXT.md`](../CONTEXT.md)                                                                                                                                                                                                         | A domain term is settled or renamed.                            |
| Accepted decisions and rationale              | Individual [ADRs](adr/README.md)                                                                                                                                                                                                      | A decision is accepted, superseded, or replaced.                |
| Current system and Module architecture        | [Architecture documents](#architecture)                                                                                                                                                                                               | Implemented architecture or one of its boundaries changes.      |
| Public TypeScript Interfaces and behavior     | Package-root [`@silksong-git/core`](../packages/core/src/index.ts), [`@silksong-git/history`](../packages/history/src/index.ts), and [`@silksong-git/repo-session`](../packages/repo-session/src/index.ts) exports and behavior tests | A callable contract or its behavior changes.                    |
| CLI syntax, safety, and error behavior        | [CLI Reference](reference/cli.md), implementation, and behavior tests                                                                                                                                                                 | User-facing CLI behavior changes.                               |
| Local HTTP protocol                           | Runtime schemas, generated OpenAPI, and the [Local HTTP API Reference](reference/local-http-api.md)                                                                                                                                   | Wire behavior or its executable contract changes.               |
| Intended outcomes and changing delivery state | GitHub specs and tickets, governed by the [issue tracker rules](agents/issue-tracker.md)                                                                                                                                              | Scope, acceptance, dependencies, claims, or state changes.      |
| Explicitly rejected project enhancements      | `.out-of-scope/`, governed by the [issue tracker rules](agents/issue-tracker.md#project-level-rejected-enhancements)                                                                                                                  | A rejection is accepted, clarified, or reconsidered.            |
| Implementation and verification history       | Commits, pull requests, and CI                                                                                                                                                                                                        | A change is implemented or verified.                            |
| Preserved pre-Solid Web behavior              | [Legacy Web references](legacy/web-before-solid/overview.md)                                                                                                                                                                          | Historical evidence is clarified or reclassified.               |
| Agent tracker and domain-consumption rules    | [`agents/`](agents/)                                                                                                                                                                                                                  | Agent workflow, tracker, triage, or domain-consumption changes. |

## Architecture

- [System Overview](architecture/overview.md) — package topology, dependency
  direction, data ownership, main flows, and cross-Module guardrails.
- [Semantic Core](architecture/semantic-core.md) — save decoding, parsing,
  Semantic Snapshots, Semantic Events, and mapping ownership.
- [Save History Module](architecture/save-history-module.md) — Save History
  Repository ownership, Raw Save Observations, Semantic Read Model workflows,
  querying, export, and restore.
- [Repo Session](architecture/repo-session.md) — runtime ownership,
  independent watcher scheduling, mandatory HTTP lifecycle, and shutdown.
- [Web](architecture/web.md) — Static Web Mode, Local History Web Mode, and
  frontend state ownership.
- [Desktop Shell](architecture/desktop-shell.md) — shared Desktop Web assets,
  native window lifecycle, navigation policy, CSP, and capability boundary.

## References

- [Reference Index](reference/README.md)
- [CLI Reference](reference/cli.md)
- [Local HTTP API Reference](reference/local-http-api.md)

Exact public TypeScript types remain owned by package-root exports. Exact Local
HTTP request and response schemas remain owned by the executable contract and
its generated OpenAPI artifact.

## Delivery

- [Global ready-for-agent frontier](https://github.com/ffff2004/silksong-git/issues?q=is%3Aissue%20is%3Aopen%20label%3Aready-for-agent%20no%3Aassignee%20-is%3Ablocked)
  — open, unassigned work without reported blockers.
- [Issue tracker rules](agents/issue-tracker.md) — how specs, tickets,
  dependencies, claims, completion, and Wayfinder artifacts are represented.
- [Triage labels](agents/triage-labels.md) — category and state vocabulary.

GitHub is the canonical source for changing delivery state. Repository
documentation links to tracker queries without copying task status or logs.

## Legacy References

- [Pre-Solid Web overview](legacy/web-before-solid/overview.md)
- [Pre-Solid save-to-semantic mapping](legacy/web-before-solid/save-to-semantic.md)

## Maintenance Rules

- Link to an authoritative source instead of restating its details.
- Architecture documents describe implemented ownership and invariants; future
  outcomes belong in tracker specs or tickets.
- Do not copy full TypeScript types, HTTP schemas, SQLite layouts, test logs, or
  ADR rationale into prose. Link to the owning source.
- Keep changing task state in GitHub rather than maintaining a repository copy.
- Legacy references must identify themselves as historical and must not be used
  as an alternative source for current architecture or semantic behavior.
