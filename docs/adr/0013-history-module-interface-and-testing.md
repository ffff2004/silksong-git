# Expose a small history module interface and test it through behavior

We decided that `packages/history` exposes a small deep Module interface for save-history workflows: `initSaveHistory`, `observeSave`, `rebuildSemanticReadModel`, `queryHistory`, `diffCommits`, `searchSemanticEvents`, `restoreEncodedSave`, and `acquireSaveHistoryWatcher`. Git, SQLite, config loading, and persistence details are implementation concerns behind this interface. File watching, scheduling, local HTTP, and their contracts belong to Repo Session.

History tests should be integration-style and use the public history interface with temporary directories, a real Git repository, and a real SQLite read model. Mocks should be limited to true system boundaries such as time and watcher event delivery. The first TDD tracer bullet should verify that `initSaveHistory` plus `observeSave` creates a raw observation that `restoreEncodedSave` can restore byte-for-byte; later vertical slices should add semantic diff/search behavior and capture-policy behavior.

`acquireSaveHistoryWatcher` is the narrow watcher-ownership seam. It owns the
startup Project Config snapshot, repository-scoped watcher ownership, and the
automatic observation transaction. Its returned lease exposes only the fixed
Watched Save and Capture Policy needed by scheduling, automatic observation at
an explicit time, and idempotent release. It neither exposes Project Config,
layout, lock, Git, or SQLite details nor changes `observeSave`'s current-config
semantics for Manual Checkpoints and Offline Commands. Repo Session consumes
this lease and owns runtime concerns without taking over History internals.

Repo Session behavior tests use its public start/stop interface with real
temporary History repositories, Git, SQLite, locks, and loopback HTTP. Only
true system boundaries—time, filesystem events, stability probes, and
scheduling—are injected. This extraction does not add a watcher-independent
session lifecycle.

The SQLite schema is not part of the external Interface. CLI and Web callers must use history query functions such as `queryHistory`, `diffCommits`, and `searchSemanticEvents`; table layout, indexes, and migrations are implementation details of `packages/history` and can change as long as those observable query behaviors remain stable.

`searchSemanticEvents` accepts structured query fields as its stable Interface. Fuzzy free-text search may exist as a convenience adapter for CLI use, but Web and programmatic callers should express searches through structured event fields.

ADR-0018 extends this Interface for the Local History Web Mode without exposing storage details. `getSaveState` reads latest or commit-selected observation state, `readEncodedSave` returns exact committed bytes for export, and `queryRawObservations` paginates Raw Save Observation metadata independently from Semantic Event history. History, Raw Observation, and search pagination use opaque cursors and explicit ordering. HTTP in-place restore adds an optional current-save precondition to the public restore target so the Adapter can prevent stale user confirmation without reimplementing restore internals.

Local History Web Mode also needs compact Semantic Snapshot summaries beside commit history without issuing one `getSaveState` request per commit. Historical Semantic Event DTOs therefore include the after-Snapshot `SaveSummaryMetrics`. Raw Observation history returns entries that pair an unchanged `RawSaveObservation` with `SaveSummaryMetrics | null`; `null` represents an Unrecognized Schema Observation. This keeps derived semantic data out of the Raw Save Observation domain object, preserves the existing independent event and observation cursors, and lets the history Module satisfy the Web caller in one query.
