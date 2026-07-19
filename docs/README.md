# Project Documentation

This is the navigation and authority entry point for project knowledge. It
separates durable domain and architecture knowledge from executable contracts,
delivery state, and preserved legacy behavior.

## Migration Status

The new documentation structure is in its compatibility phase. Its destination
documents exist as navigable stubs, while the established design and execution
documents remain authoritative until their content has been migrated and the
final contract step retires them.

Do not treat a compatibility stub as a second source of truth. Each stub links
to the source that currently owns its subject.

## Authority Map

| Knowledge                                  | Current authority                                                                                    | Target authority                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Domain vocabulary                          | [`CONTEXT.md`](../CONTEXT.md)                                                                        | Unchanged                                                                                 |
| Accepted decisions and rationale           | Individual [ADRs](adr/README.md)                                                                     | Unchanged                                                                                 |
| System and Module architecture             | [`save-history-design.md`](save-history-design.md) plus relevant ADRs                                | [Architecture documents](#architecture)                                                   |
| Public TypeScript Interfaces               | Package-root exports and behavior tests                                                              | Unchanged; architecture links to live Interfaces rather than copying them                 |
| CLI syntax, safety, and error behavior     | [`save-history-design.md`](save-history-design.md) and the CLI implementation                        | [CLI Reference](reference/cli.md)                                                         |
| Local HTTP protocol                        | Runtime schemas, generated OpenAPI, [`save-history-design.md`](save-history-design.md), and ADR-0018 | [Local HTTP API Reference](reference/local-http-api.md) backed by the executable contract |
| Current delivery state and verification    | [`implementation-plan.md`](implementation-plan.md)                                                   | GitHub specs and tickets, linked through the [Roadmap](roadmap.md)                        |
| Preserved pre-Solid Web behavior           | [`current-design-reference/`](current-design-reference/)                                             | [Legacy Web reference](legacy/web-before-solid/overview.md)                               |
| Agent tracker and domain-consumption rules | [`agents/`](agents/)                                                                                 | Unchanged                                                                                 |

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

- [Roadmap](roadmap.md) — compatibility entry point for the current initiative
  and tracker frontier.
- [Issue tracker rules](agents/issue-tracker.md) — how specs, tickets,
  dependencies, claims, and Wayfinder artifacts are represented.
- [Triage labels](agents/triage-labels.md) — category and state vocabulary.

During the compatibility phase, `implementation-plan.md` remains the execution
tracker. The Roadmap stub must not duplicate its changing status.

## Legacy References

- [Pre-Solid Web overview](legacy/web-before-solid/overview.md)
- [Pre-Solid save-to-semantic mapping](legacy/web-before-solid/save-to-semantic.md)

The compatibility targets above link to the existing current-design references
until their classification and migration ticket completes.

## Classification Rules

Store each fact according to the question it answers:

| Question                                             | Owner                                   |
| ---------------------------------------------------- | --------------------------------------- |
| What does this domain term mean?                     | `CONTEXT.md`                            |
| How is the current system divided and constrained?   | Architecture                            |
| Why was a durable decision accepted?                 | ADR                                     |
| What is the exact callable or wire contract?         | Code, generated contract, and Reference |
| What user outcome should a future change deliver?    | GitHub spec                             |
| What can an agent implement now, and what blocks it? | GitHub ticket                           |
| What happened during implementation and validation?  | Pull request, CI, and Git history       |
| What old behavior must a migration preserve?         | Legacy reference                        |

Link to an authoritative source instead of restating its details.

## Compatibility Rules

- Old design and execution documents remain authoritative until the final
  contract step.
- A migration ticket replaces only its assigned stub and does not edit this
  index, `AGENTS.md`, or retire old documents.
- Parallel migration tickets must not copy full TypeScript types, HTTP schemas,
  SQLite layouts, test logs, or ADR rationale.
- The final contract step updates central navigation, confirms every old
  section has an owner, and only then retires the old authority documents.
