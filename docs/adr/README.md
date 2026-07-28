# Architecture Decision Records

Each ADR owns one accepted decision and its rationale. Architecture documents
describe the resulting current system and link here instead of repeating that
rationale.

- [ADR-0001 — Store raw save observations in Git and semantic history in SQLite](0001-save-history-artifacts.md)
- [ADR-0002 — Model semantic events as item-level state transitions](0002-item-level-semantic-events.md)
- [ADR-0003 — Cover Web UI items and save summary metrics in semantic snapshots](0003-semantic-snapshot-coverage.md)
- [ADR-0004 — Resolve config from built-in defaults, project config, and CLI args](0004-config-scopes-and-precedence.md)
- [ADR-0005 — Use one save history repository per watched save](0005-single-save-history-repository.md)
- [ADR-0006 — Use a small raw-observation repository layout](0006-save-history-repository-layout.md)
- [ADR-0007 — Require an explicit restore target unless in-place restore is requested](0007-restore-requires-explicit-target-or-in-place-confirmation.md)
- [ADR-0008 — Use one Repo Session for watching and the local history API](0008-one-local-process-owns-watching-and-local-history-api.md)
- [ADR-0009 — Use one Web UI with static and local history modes](0009-one-web-ui-with-static-and-local-history-modes.md)
- [ADR-0010 — Keep the first CLI command set object-grouped and lifecycle-oriented](0010-first-version-cli-command-set.md)
- [ADR-0011 — Split the fork into core, history, Repo Session, CLI, and Web workspace packages](0011-workspace-package-architecture.md)
- [ADR-0012 — Expose a small semantic core interface](0012-core-semantic-module-interface.md)
- [ADR-0013 — Expose a small history module interface and test it through behavior](0013-history-module-interface-and-testing.md)
- [ADR-0014 — Generate numeric semantic events from meaningful state transitions](0014-numeric-semantic-event-rules.md)
- [ADR-0015 — Record version stamps for decoding and semantic mapping](0015-version-stamps-for-decoding-and-semantic-mapping.md)
- [ADR-0016 — Commit decoded observations even when the save schema is unrecognized](0016-commit-unrecognized-schema-observations.md)
- [ADR-0017 — Start implementation with a core semantic tracer bullet](0017-start-implementation-with-core-tracer-bullet.md)
- [ADR-0018 — Serve a secure versioned local HTTP Adapter from Repo Session](0018-secure-versioned-local-http-adapter.md)
- [ADR-0019 — Extract Repo Session ownership above History](0019-extract-repo-session-ownership.md)
- [ADR-0020 — Decouple Repo Session HTTP and watcher lifetimes](0020-decouple-repo-session-http-and-watcher-lifetimes.md)
