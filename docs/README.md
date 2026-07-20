# Project Documentation

This is the navigation and authority entry point for project knowledge. It
separates durable domain and architecture knowledge from executable contracts,
delivery state, and preserved legacy behavior.

## Authority Map

| Knowledge                                  | Authority                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain vocabulary                          | [`CONTEXT.md`](../CONTEXT.md)                                                                                                                                 |
| Accepted decisions and rationale           | Individual [ADRs](adr/README.md)                                                                                                                              |
| Current system and Module architecture     | [Architecture documents](#architecture)                                                                                                                       |
| Public TypeScript Interfaces               | Package-root [`@silksong-git/core`](../packages/core/src/index.ts) and [`@silksong-git/history`](../packages/history/src/index.ts) exports and behavior tests |
| CLI syntax, safety, and error behavior     | [CLI Reference](reference/cli.md), implementation, and behavior tests                                                                                         |
| Local HTTP protocol                        | Runtime schemas, generated OpenAPI, and the [Local HTTP API Reference](reference/local-http-api.md)                                                           |
| Current delivery state, blockers, claims   | GitHub specs and tickets, linked through the [Roadmap](roadmap.md)                                                                                            |
| Explicitly rejected project enhancements   | `.out-of-scope/`, governed by the [issue tracker rules](agents/issue-tracker.md#project-level-rejected-enhancements)                                          |
| Implementation and verification history    | Commits, pull requests, and CI                                                                                                                                |
| Preserved pre-Solid Web behavior           | [Legacy Web references](legacy/web-before-solid/overview.md)                                                                                                  |
| Agent tracker and domain-consumption rules | [`agents/`](agents/)                                                                                                                                          |

## Architecture

- [System Overview](architecture/overview.md) — package topology, dependency
  direction, data ownership, main flows, and cross-Module guardrails.
- [Semantic Core](architecture/semantic-core.md) — save decoding, parsing,
  Semantic Snapshots, Semantic Events, and mapping ownership.
- [Save History Module](architecture/save-history-module.md) — Save History
  Repository ownership, Raw Save Observations, Semantic Read Model workflows,
  querying, export, and restore.
- [Local History Watch Process](architecture/local-history-watch-process.md) —
  runtime ownership, scheduling, process state, optional HTTP lifecycle, and
  shutdown.
- [Web](architecture/web.md) — Static Web Mode, Local History Web Mode, and
  frontend state ownership.

## References

- [Reference Index](reference/README.md)
- [CLI Reference](reference/cli.md)
- [Local HTTP API Reference](reference/local-http-api.md)

Exact public TypeScript types remain owned by package-root exports. Exact Local
HTTP request and response schemas remain owned by the executable contract and
its generated OpenAPI artifact.

## Delivery

- [Roadmap](roadmap.md) — current initiatives and tracker frontier.
- [Issue tracker rules](agents/issue-tracker.md) — how specs, tickets,
  dependencies, claims, and Wayfinder artifacts are represented.
- [Triage labels](agents/triage-labels.md) — category and state vocabulary.

GitHub is the canonical source for changing delivery state. Repository
documentation links to tracker queries without copying task status or logs.

## Legacy References

- [Pre-Solid Web overview](legacy/web-before-solid/overview.md)
- [Pre-Solid save-to-semantic mapping](legacy/web-before-solid/save-to-semantic.md)

## Classification Rules

Store each fact according to the question it answers:

| Question                                              | Owner                                   |
| ----------------------------------------------------- | --------------------------------------- |
| What does this domain term mean?                      | `CONTEXT.md`                            |
| How is the current system divided and constrained?    | Architecture                            |
| Why was a durable decision accepted?                  | ADR                                     |
| What is the exact callable or wire contract?          | Code, generated contract, and Reference |
| What user outcome should a future change deliver?     | GitHub spec                             |
| What can an agent implement now, and what blocks it?  | GitHub ticket                           |
| What enhancement has the project explicitly rejected? | `.out-of-scope/<concept>.md`            |
| What happened during implementation and validation?   | Pull request, CI, and Git history       |
| What old behavior must a migration preserve?          | Legacy reference                        |

Link to an authoritative source instead of restating its details.

## Maintenance Rules

- Architecture documents describe implemented ownership and invariants; future
  outcomes belong in tracker specs or tickets.
- Do not copy full TypeScript types, HTTP schemas, SQLite layouts, test logs, or
  ADR rationale into prose. Link to the owning source.
- Keep changing task state in GitHub rather than maintaining a repository copy.
- Legacy references must identify themselves as historical and must not be used
  as an alternative source for current architecture or semantic behavior.
