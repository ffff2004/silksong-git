# Save History Module Architecture

The Save History Module owns durable local history for one Watched Save. It
turns stable save-file reads into canonical Git Raw Save Observations, maintains
a rebuildable SQLite Semantic Read Model, and exposes repository workflows
through the package-root
[`@silksong-git/history` Interface](../../packages/history/src/index.ts).
Callers must not depend on its Git commands, SQLite tables, repository layout
helpers, or lock implementation.

The one-repository-per-save boundary follows
[ADR-0005](../adr/0005-single-save-history-repository.md), and the small public
Interface and behavior-test boundary follow
[ADR-0013](../adr/0013-history-module-interface-and-testing.md). Exact callable
types remain in the package export rather than being duplicated here.

## Repository Compatibility and Migration

History inspects a candidate repository through its public Interface before a
caller opens a session or changes durable state. Inspection is read-only and
returns a safe status, a user action, an opaque short-lived inspection ID, and
only the capabilities that History has proved safe. It does not reveal Project
Config contents, Git layout, lock state, or SQLite details.

The durable Project Config owns the monotonic `repositoryFormatVersion`.
The currently supported value is `1`. A valid unversioned config is a strict
`legacyConfig`; a known lower value is `migrationRequired`; and a valid higher
value is `newerIncompatible`. Malformed candidates, structurally invalid
repositories, and non-repositories are `invalid`. Strict inspection uses both
the Git work-tree check and Git integrity validation, preserving the CLI's
refusal of damaged repositories. Desktop's migration preflight may request
structural classification with an advisory integrity policy; its verified
snapshot reports any Git integrity warning while allowing migration. A newer
incompatible repository exposes
no ordinary read or write capability by default; a caller must use a compatible
newer application rather than relying on an incidental parse of its files.

The Repo Session may explicitly request read-only access for a Desktop Archived
Repository. That access admits compatible legacy or migration-required data for
read and export workflows, using advisory integrity classification, while the
normal History and CLI paths retain strict compatibility and capability checks.

An explicitly confirmed migration consumes the inspection ID under History's
write serialization. History re-inspects the candidate, rejects stale IDs,
creates a recoverable config backup, and atomically persists the supported
format version. It never uses this workflow to alter Git Raw Save
Observations. All ordinary writers—including observation, watcher acquisition,
restore, and read-model rebuild—pass through the same compatibility guard.
Initialization likewise refuses to overwrite an existing incompatible
repository.

Desktop's migration workflow uses the two-phase
`prepareSaveHistoryMigration` Interface. Desktop supplies the canonical source
repository path, an opaque target snapshot path, the inspection ID, and the
literal confirmation; History does not own managed/archive roots or parse
archive names. Preparation holds repository serialization and watcher
exclusion, copies the complete durable repository to a staging directory,
compares canonical SHA-256 Merkle directory digests before and after the copy,
advises on Git integrity, and atomically publishes the collision-adjusted
snapshot path. It returns a non-cancelable in-memory operation lease. Desktop
reports that actual path and any advisory warning before calling the operation's
`commit`, which then performs the existing migration ordering. Every migration
result reports whether the source is unchanged, migrated, or unknown and
whether an archive snapshot was not created or remains retained. Snapshot
failure does not migrate or modify the source; a published snapshot is
retained even when migration later fails. Lease-release failure is reported as
a separate lifecycle warning without replacing those source and snapshot
states. The one-phase CLI migration remains unchanged.

History also exposes the narrow standalone Desktop archive move. It does not
inspect repository compatibility or assign archive lifecycle. Given canonical
App-owned roots, one direct non-symlink child, and an opaque App-generated name,
History holds its write and watcher exclusions where applicable and atomically
renames the directory to an unused direct archive child. Existing watcher
ownership is refused, and failures before rename leave the source unchanged.
This move never reads the Watched Save, creates an observation, copies an
Archive Snapshot, edits Project Config, or initializes a replacement.

Semantic Read Model schema metadata is intentionally separate from the durable
repository format. Missing, stale, corrupt, or newer SQLite state in an
otherwise compatible repository yields `rebuildRequired`, not
`newerIncompatible`. Rebuild remains the only permitted maintenance action for
that state and replaces derived SQLite state without changing canonical Git
history.

## Boundary and Ownership

History owns the persistence rules and adapters behind its public Interface:

| Resource                              | History ownership and authority                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save History Repository               | One local Git repository represents one Watched Save. History initializes it, resolves commits, and writes Raw Save Observations. Git is the canonical raw history and restore source.                                                                                                |
| Encoded Save artifact                 | The committed `save.dat` bytes are the canonical artifact for export and restore.                                                                                                                                                                                                     |
| Decoded Save and Observation Metadata | Each Raw Save Observation also commits the decoded payload and metadata needed for inspection, provenance, and later semantic rebuilds. These are raw observation artifacts, not semantic truth.                                                                                      |
| Project Config                        | Repository-scoped config records the Watched Save path, Capture Policy, Display Semantic Event Filters, and restore defaults. History reads it when executing repository behavior. Effective Config precedence is defined by [ADR-0004](../adr/0004-config-scopes-and-precedence.md). |
| Semantic Read Model                   | History derives Semantic Snapshots, Semantic Events, observation lookup data, and semantic Version Stamps into SQLite, then applies Project Config display filters when querying. It is query authority but is rebuildable from Git, so it is not a restore source.                   |
| `write.lock`                          | History uses this short-lived repository lock to serialize Git and SQLite mutations for observations and rebuilds, and the full in-place restore transaction. Offline Commands and Repo Sessions share this lock instead of creating separate write paths.                            |
| `watch.lock`                          | History implements the repository-scoped singleton lock held by an acquired Save History Watcher lease. Its acquisition, lifetime, and release belong to watcher ownership and are distinct from an observation transaction.                                                          |

The repository currently tracks the Project Config and current observation's
Encoded Save, Decoded Save, and Observation Metadata. The SQLite read model and
both locks are ignored runtime artifacts. The accepted artifact split is
recorded in [ADR-0001](../adr/0001-save-history-artifacts.md) and
[ADR-0006](../adr/0006-save-history-repository-layout.md); their concrete
filenames and the SQLite schema remain internal implementation details.

History consumes the
[`@silksong-git/core` Interface](../../packages/core/src/index.ts) for decoding,
schema recognition, Semantic Snapshot creation, and semantic diffing. Core does
not know about repositories or SQLite. CLI and HTTP adapters call History's
package-root Interface rather than running Git, querying tables, or applying
restore rules themselves.

## Observation Transaction

`observeSave` is the public single-observation transaction used by Manual
Checkpoints and Offline Commands. Under `write.lock`, History reads the Watched
Save path from current Project Config and returns one of three outcomes. An
acquired Save History Watcher lease uses the same transaction under `write.lock`
with its private startup Project Config snapshot and a watcher trigger.

- `committed` means History wrote a Raw Save Observation to Git. If Core
  recognizes the Save Schema Version, History also appends the Semantic
  Snapshot and resulting Semantic Events to SQLite. If the schema is
  unrecognized, the Git observation is still canonical and its semantic update
  is unavailable until a future rebuild supports it. A read-model failure can
  likewise leave a committed raw observation with semantic data unavailable.
- `skipped` means Git and SQLite were not changed. Current reasons are unchanged
  Encoded Save bytes or the Minimum Commit Interval. A Manual Checkpoint bypasses
  the interval and commits unchanged bytes only when the caller explicitly
  allows that behavior.
- `watcherError` means no Raw Save Observation was committed because History
  could not read or decode the candidate save. The same result shape is returned
  to a Manual Checkpoint caller even though no watcher scheduling is involved.

A decoded but unrecognized shape is therefore a committed
Unrecognized Schema Observation, while a decode failure is a non-committed
error, as required by
[ADR-0016](../adr/0016-commit-unrecognized-schema-observations.md). Display
Semantic Event Filters never decide whether an observation enters Git and do
not delete derived events from SQLite.

This transaction does not own file-event debounce, stability probes,
single-flight dirty-bit handling, deferred observation timers, Repo Session
status, or shutdown. When a Minimum Commit Interval skip includes a next-allowed time, the caller may use it as scheduling input; the
[Repo Session](repo-session.md) owns that
orchestration and calls `observeSave` again at the appropriate time.

## Public Read and Maintenance Workflows

These workflows are public History behavior. Their result DTOs and errors are
owned by the live package-root Interface, while integration behavior is covered
by the
[`@silksong-git/history` behavior tests](../../packages/history/src/index.test.ts).

### History, diff, and search

- `queryHistory` pages Semantic Events in an explicit order and returns each
  event with its commits, Raw Save Observation context, after-Snapshot summary,
  and visibility metadata.
- `queryRawObservations` independently pages raw observations with an optional
  Semantic Snapshot summary. An Unrecognized Schema Observation has no semantic
  summary.
- `diffCommits` resolves two observation commits and returns their Semantic
  Snapshots and the Semantic Events between them.
- `searchSemanticEvents` searches through structured semantic fields and also
  supports the CLI's free-text convenience. Structured fields are the stable
  programmatic search seam.

History, raw-observation, and search pagination use opaque cursors. Display
Semantic Event Filters apply to semantic history, diff, and search at query
time; callers can explicitly include filtered events and inspect why they are
hidden by default. Raw Save Observation history is independent of semantic
visibility.

### Save State and export

`getSaveState` resolves `latest` or a supplied commit ref once, then reads the
observation's artifacts at that immutable commit. An empty repository is a
normal result. An Unrecognized Schema Observation remains inspectable as a
Decoded Save with no Semantic Snapshot; a recognized observation whose
snapshot is unavailable reports the missing read model rather than remapping
silently.

`readEncodedSave` is the export behavior: it returns the exact committed
Encoded Save bytes, their hash, commit identity, and a safe suggested filename.
It does not write a Restore Target. HTTP download headers and CLI presentation
belong to their adapters, not to History.

### Rebuild

`rebuildSemanticReadModel` recreates SQLite semantic state from Git Raw Save
Observations using the current Core interpretation and built-in Mapping Data.
It preserves unrecognized observations as raw history without inventing
snapshots or events for them, reports rebuild counts, and holds `write.lock`
while replacing the read model. Project Config Display Semantic Event Filters
apply later at query time; rebuild never rewrites canonical Git history.
It is admitted only when repository inspection grants the rebuild capability;
the caller must explicitly rebuild before ordinary writers resume.

### Restore

`restoreEncodedSave` reads the selected commit's exact Encoded Save artifact.
An explicit Restore Target is the safe default and is not overwritten unless
the caller explicitly requests overwrite. In-place restore instead resolves the
Watched Save from Project Config, requires the public confirmation value,
creates a byte-for-byte backup when the file exists, writes and verifies the
selected bytes, and holds `write.lock` for the transaction.

The public in-place target also accepts an expected-current precondition. The
HTTP adapter requires it so History can reject a stale or unexpectedly present
Watched Save before backup or overwrite; the current explicit CLI confirmation
workflow may omit it. Restore itself does not create a Raw Save Observation.
Detailed safety decisions are recorded in
[ADR-0007](../adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md)
and the Local History HTTP refinement in
[ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md).

## Caller and Repo Session Boundary

The Repo Session is the caller and orchestrator of
this Module's observation and query behavior. Its mandatory local HTTP listener
can serve readers and mutations without watcher ownership. When watching is
started, it obtains a Save History Watcher lease and owns the watch subscription
while that lease owns `watch.lock`. It does not
implement a second Git, SQLite, observation, export, or restore path. Manual
checkpoints, HTTP mutations, and Offline Commands call the direct History
Interface with current Project Config and serialize through `write.lock`
without acquiring watcher ownership.

The HTTP adapter is likewise an adapter over public History behavior. Its exact
authentication, request, response, compatibility, and download contracts live
in the [Local HTTP API Reference](../reference/local-http-api.md), not in this
Module document. Repo Session startup, observation scheduling, and graceful shutdown
live in the
[Repo Session architecture](repo-session.md).
