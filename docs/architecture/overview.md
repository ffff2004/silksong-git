# System Architecture Overview

This workspace separates browser-safe semantic interpretation from local
persistence and process concerns. Applications depend on package Interfaces;
packages do not depend on applications.

## Module Map

```txt
Static Web Mode ----------------------> @silksong-git/core
Local History Web Mode --HTTP client--> Local HTTP Adapter
CLI --------------------+-------------> @silksong-git/history
                        +-------------> @silksong-git/core
Local HTTP Adapter -------------------> @silksong-git/history
@silksong-git/history ----------------> @silksong-git/core
```

| Module                                                       | Current responsibility and dependency boundary                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](../../packages/core/src/index.ts)          | Decodes and parses saves, supplies builtin Mapping Data, creates Semantic Snapshots, and diffs them into Semantic Events. It is browser-safe and has no DOM, Git, SQLite, filesystem-watching, or HTTP responsibility.                                                                 |
| [`packages/history`](../../packages/history/src/index.ts)    | Owns one Save History Repository, Git and SQLite adapters, observation and restore workflows, query/diff/search behavior, repository locks, the Local History Watch Process, and its optional HTTP adapter. It depends on Core for semantic interpretation.                            |
| [`apps/cli`](../../apps/cli/src/main.ts)                     | Parses commands and renders terminal or JSON output. Save inspection calls Core; repository, history, restore, and watch commands call the public History Interface. It does not own persistence rules.                                                                                |
| [`apps/web`](../../apps/web/src/main.tsx)                    | Runs one Solid frontend in Static Web Mode or Local History Web Mode. Static mode calls Core in the browser. Local mode uses the browser-safe HTTP wire contract and an authenticated HTTP client; it does not import History's Node runtime or access local storage systems directly. |
| [Local HTTP Adapter](../../packages/history/src/http-app.ts) | Runs only when enabled inside the Local History Watch Process. It authenticates and validates versioned loopback requests, then adapts them to History workflows. It does not create an independent persistence path or serve the Web frontend.                                        |

The package split follows
[ADR-0011](../adr/0011-workspace-package-architecture.md). Exact callable
Interfaces remain owned by package-root exports; exact HTTP shapes remain owned
by the [executable contract](../../packages/history/src/http-contract.ts), its
[browser-safe wire schemas](../../packages/history/src/http-wire.ts), and the
OpenAPI document generated on demand as described by the
[Local HTTP API Reference](../reference/local-http-api.md).

## Data Ownership

Each Save History Repository represents one Watched Save. Git and SQLite serve
different purposes:

| Store                         | Ownership                                                                                                                               | Authority                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Save History Repository (Git) | History tracks Project Config alongside each observation's Encoded Save, Decoded Save, and Observation Metadata.                        | Canonical raw history and the source for byte-for-byte restore. |
| SQLite Semantic Read Model    | History derives Semantic Snapshots, Semantic Events, Display Semantic Event Filter metadata, and semantic Version Stamps from Git data. | Rebuildable query data, not canonical history.                  |

History rebuilds the read model from Git through Core using the current parser
and built-in Mapping Data. Capture Policy decides which stable raw observations
enter Git; Project Config supplies Display Semantic Event Filters, which History
applies later when querying the rebuilt model. See
[ADR-0001](../adr/0001-save-history-artifacts.md),
[ADR-0005](../adr/0005-single-save-history-repository.md), and
[ADR-0006](../adr/0006-save-history-repository-layout.md).

## Principal Flows

### Static save inspection

The Web app receives an uploaded Encoded Save or Decoded Save, calls Core, and
renders the resulting current semantic state. This flow remains entirely in
the browser and has no Git, SQLite, watcher, or local HTTP dependency.

### Observation and semantic indexing

The Local History Watch Process and CLI Manual Checkpoint both invoke History's
observation workflow. History reads and decodes the Watched Save. Watch-triggered
work applies the Capture Policy; a Manual Checkpoint bypasses the Minimum Commit
Interval and may explicitly allow unchanged bytes. A committed Raw Save
Observation updates the SQLite read model when Core recognizes its Save Schema
Version. A successfully decoded save with an unrecognized Save Schema Version
is committed as an Unrecognized Schema Observation. For watch-triggered work, a
decode or file failure is a non-committed Watcher Error; a Manual Checkpoint
reports the corresponding failure without committing. Detailed ownership
belongs to the
[Save History Module](save-history-module.md) and
[Local History Watch Process](local-history-watch-process.md) documents.

### Offline CLI workflow

Repository-scoped CLI commands call History directly to initialize, observe,
query, diff, search, rebuild, or restore. These commands do not require
the watch process, but write operations use History's repository lock rather
than bypassing its persistence boundary. Save decode and snapshot commands call
Core directly. Command syntax and safety behavior belong in the
[CLI Reference](../reference/cli.md).

### Local History Web workflow

The watch process may start the versioned Local HTTP Adapter on loopback with a
per-start bearer token. The Web client performs an authenticated watcher probe
and then obtains save state, history, diff, search, checkpoint, export, and
restore behavior through that adapter. The adapter delegates to History; the
frontend never runs Git or SQLite operations. The process owns the HTTP
listener lifecycle, while frontend serving remains separate. See
[ADR-0008](../adr/0008-one-local-process-owns-watching-and-local-history-api.md),
[ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md), and the
[Local HTTP API Reference](../reference/local-http-api.md).

## Cross-Module Guardrails

- Core remains free of DOM, Git, SQLite, filesystem watching, and HTTP concerns.
- History is the only Module that owns Git, SQLite, repository locking,
  observation, restore, and watch-process behavior.
- CLI and HTTP endpoint workflows must call public History Interfaces instead
  of Git commands, SQLite tables, or internal persistence helpers.
- The Web frontend uses Core for browser-only semantic work and local HTTP for
  local-history work; it never directly accesses Git, SQLite, the watcher, or
  the local filesystem.
- Raw capture and semantic display are independent: display filters neither
  suppress Git observations nor delete Semantic Events from SQLite.
- The watch process is the singleton long-running writer for a repository.
  Offline writes and manual checkpoints serialize through History's short-lived
  write lock; they do not start a second watcher.
- Restore defaults to an explicit target. In-place restore requires explicit
  confirmation and backup behavior owned by History, as recorded in
  [ADR-0007](../adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md).

Capability details live in the [Semantic Core](semantic-core.md),
[Save History Module](save-history-module.md),
[Local History Watch Process](local-history-watch-process.md), and
[Web](web.md) architecture documents. Accepted rationale is indexed in the
[ADR index](../adr/README.md); those sources should be linked rather than
duplicated here.
