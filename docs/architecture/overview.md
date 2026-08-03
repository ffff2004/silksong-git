# System Architecture Overview

This workspace separates browser-safe semantic interpretation from local
persistence and process concerns. Applications depend on package Interfaces;
packages do not depend on applications.

## Module Map

```txt
Static Web Mode ----------------------> @silksong-git/core
Desktop Static Mode ----Tauri picker/sidecar----> @silksong-git/core
Desktop Rust -------JSONL------> Desktop sidecar ---> @silksong-git/repo-session
Local History Web Mode --HTTP client--> @silksong-git/repo-session/http-wire
CLI --------------------+-------------> @silksong-git/history
                        +-------------> @silksong-git/repo-session
                        +-------------> @silksong-git/core
@silksong-git/repo-session -----------> @silksong-git/history
@silksong-git/history ----------------> @silksong-git/core
```

| Module                                                              | Current responsibility and dependency boundary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](../../packages/core/src/index.ts)                 | Decodes and parses saves, supplies builtin Mapping Data, creates Semantic Snapshots, and diffs them into Semantic Events. It is browser-safe and has no DOM, Git, SQLite, filesystem-watching, or HTTP responsibility.                                                                                                                                                                        |
| [`packages/history`](../../packages/history/src/index.ts)           | Owns one Save History Repository, Git and SQLite adapters, observation and restore workflows, query/diff/search behavior, repository locks, and watcher leases. It depends on Core for semantic interpretation.                                                                                                                                                                               |
| [`packages/repo-session`](../../packages/repo-session/src/index.ts) | Owns the long-running repository reader process, mandatory loopback HTTP Adapter, independently controlled watcher scheduling, executable HTTP contract, and browser-safe wire contract. It calls only public History workflows.                                                                                                                                                              |
| [`apps/cli`](../../apps/cli/src/main.ts)                            | Parses commands and renders terminal or JSON output. Save inspection calls Core; repository, history, and restore commands call History, while `watch start` starts a Repo Session. It does not own persistence rules.                                                                                                                                                                        |
| [`apps/web`](../../apps/web/src/main.tsx)                           | Runs one Solid frontend in Static Web Mode or Local History Web Mode. Browser Static mode calls Core in the browser; Desktop Static inspection receives already-decoded data through a narrow native capability. Local mode uses Repo Session's browser-safe HTTP wire contract and an authenticated HTTP client; it does not import a Node runtime or access local storage systems directly. |
| [`apps/desktop`](../../apps/desktop/src-tauri/src/lib.rs)           | Runs the single-instance Tauri shell around a dedicated build of the shared Web source. It owns the one native window, bundled-content boundary, navigation policy, external opening, external repository selection, and the one sidecar-backed Repo Session runtime.                                                                                                                         |
| [`apps/desktop-sidecar`](../../apps/desktop-sidecar/src/main.ts)    | Provides the private versioned JSONL process Adapter for Repo Session lifecycle commands, the confirmed migration exception through History's public Interface, and stateless Core save inspection. Desktop Rust spawns its fixed development entry through Node and communicates over its stdin/stdout protocol.                                                                             |

The package split follows
[ADR-0011](../adr/0011-workspace-package-architecture.md). Exact callable
Interfaces remain owned by package-root exports; exact HTTP shapes remain owned
by the [executable contract](../../packages/repo-session/src/http-contract.ts), its
[browser-safe wire schemas](../../packages/repo-session/src/http-wire.ts), and the
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
renders the resulting current semantic state. Browser and Desktop use separate
asset builds but the same presentation behavior and Static Runtime
Capabilities. This flow remains entirely in the Web presentation and has no
Git, SQLite, watcher, or local HTTP dependency.

### Observation and semantic indexing

The Repo Session and CLI Manual Checkpoint both invoke History's
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
[Repo Session](repo-session.md) documents.

### Offline CLI workflow

Repository-scoped CLI commands call History directly to initialize, observe,
query, diff, search, rebuild, or restore. These commands do not require
a Repo Session, but write operations use History's repository lock rather
than bypassing its persistence boundary. Save decode and snapshot commands call
Core directly. Command syntax and safety behavior belong in the
[CLI Reference](../reference/cli.md).

### Local History Web workflow

Opening a Repo Session starts the versioned Local HTTP Adapter on loopback with
a per-session bearer token while leaving watching inactive. The Web client performs an authenticated watcher probe
and then obtains save state, history, diff, search, checkpoint, export, and
restore behavior through that adapter. The adapter delegates to History; the
frontend never runs Git or SQLite operations. The Repo Session owns the HTTP
listener lifecycle, while frontend serving remains separate. See
[ADR-0008](../adr/0008-one-local-process-owns-watching-and-local-history-api.md),
[ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md), and the
[Local HTTP API Reference](../reference/local-http-api.md).

## Cross-Module Guardrails

- Core remains free of DOM, Git, SQLite, filesystem watching, and HTTP concerns.
- History is the only Module that owns Git, SQLite, repository locking,
  observation, and restore behavior. Repo Session owns process scheduling and
  HTTP lifecycle above that persistence boundary.
- CLI and HTTP endpoint workflows must call public History Interfaces instead
  of Git commands, SQLite tables, or internal persistence helpers.
- The Web frontend uses Core for browser-only semantic work and local HTTP for
  local-history work; it never directly accesses Git, SQLite, the watcher, or
  the local filesystem.
- The Desktop shell bundles its Web assets and exposes no guest-callable native
  permissions. Rust owns native window, navigation, popup, and validated
  external-opening behavior.
- The Desktop sidecar translates Repo Session lifecycle commands and safe
  lifecycle events, plus stateless `save.inspect` requests through the public
  Core Interface. History data remains on authenticated loopback HTTP; the
  Adapter does not bypass either public Interface or open History state for
  static inspection.
- Confirmed migration is the explicit exception: incompatible Managed
  Repositories cannot open Repo Session HTTP, so the sidecar calls History's
  public migration Interface directly for the prepare/commit workflow. History
  still owns migration mechanics and locks; the sidecar does not become a
  generic History adapter.
- Raw capture and semantic display are independent: display filters neither
  suppress Git observations nor delete Semantic Events from SQLite.
- Only an active Repo Session watcher is singleton for a repository. Multiple
  reader sessions may coexist; Offline writes, HTTP mutations, and watcher
  observations serialize through History's short-lived write lock.
- Restore defaults to an explicit target. In-place restore requires explicit
  confirmation and backup behavior owned by History, as recorded in
  [ADR-0007](../adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md).

Capability details live in the [Semantic Core](semantic-core.md),
[Save History Module](save-history-module.md),
[Repo Session](repo-session.md), and
[Web](web.md), and [Desktop Shell](desktop-shell.md) architecture documents.
Accepted rationale is indexed in the
[ADR index](../adr/README.md); those sources should be linked rather than
duplicated here.
