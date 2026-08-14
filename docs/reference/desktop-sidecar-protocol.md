# Desktop Sidecar Process Protocol

The private `@silksong-git/desktop-sidecar` workspace application adapts the
public Repo Session Interface for the Tauri Rust caller. It is a Node.js
development executable and is not a packaged Tauri external binary. The
executable protocol schemas in
[`protocol.ts`](../../apps/desktop-sidecar/src/protocol.ts) are authoritative.
The current version is defined only in
[`protocol-version.json`](../../apps/desktop-sidecar/src/protocol-version.json).
The TypeScript schema imports it directly and the Desktop Rust build generates
its matching protocol constant from the same input. This reference uses
`<protocol-version>` as a placeholder rather than copying that number.

Run the development entry point from the workspace:

```sh
pnpm dev-desktop-sidecar
```

## Transport and envelopes

The protocol is UTF-8 JSON Lines. The caller writes one command envelope per
stdin line and continuously drains stdout and stderr. Stdout contains only
command responses and events; fixed diagnostic text uses stderr. A command
has this common envelope:

```json
{
  "protocolVersion": "<protocol-version>",
  "kind": "command",
  "requestId": "caller-unique-id",
  "command": { "type": "watcher.start" }
}
```

Every accepted line receives exactly one response with the same `requestId`.
Malformed envelopes use `null` because no request identity was accepted.
Success responses set `ok` to `true` and carry a discriminated `result`;
failures set it to `false` and carry a stable `error.code` plus a safe message.
Events have no request ID:

```json
{
  "protocolVersion": "<protocol-version>",
  "kind": "event",
  "event": { "type": "process.ready" }
}
```

Commands are processed serially. Events produced while a command runs are
buffered until that command's response has been flushed. Consumers must ignore
an event whose `event.type` they do not understand. They must reject malformed
payloads for known event types and protocol versions they do not support.

## Lifecycle

The current protocol version accepts these commands:

- `repository.inspect` with one absolute `repoPath` and an optional
  `gitIntegrityPolicy` of `strict` (default) or `advisory`;
- `repository.initialize` with one absolute managed `repoPath` and one
  absolute `watchedSavePath`, establishing the repository and first baseline
  observation through History's public `initSaveHistory` and `observeSave`
  workflows;
- `repository.compareWatchedSave` with one absolute managed `repoPath` and one
  absolute candidate `savePath`, returning only whether History's canonical
  Watched Save identity matches the candidate for current or legacy-compatible
  Project Config. An unavailable or incompatible config is a comparison
  failure, not a false match;
- `repository.compareWatchedSaveRepositories` with two absolute repository
  paths, returning only whether their configured Watched Save identities match;
- `repository.import` with an absolute external `sourcePath`, an App-owned
  absolute `targetPath`, and an App-owned absolute `stagingRootPath`, returning a structured copied, rejected, or failed
  result. Operational failures include a phase, reason, unchanged source
  state, safe message, and any retained path; session or mutation busy states
  use this result rather than a generic error envelope. Schema-invalid import
  commands use the same successful response envelope with
  `failed/preflight/invalidCommand/unchanged`, and do not inspect, copy, or
  remove the source;
- `repository.archive` with an absolute `sourcePath` and an App-generated
  absolute `targetPath`;
- `repository.replacement.prepare` with an App-generated lifecycle
  `operationId`, an absolute `sourcePath`, an App-generated absolute
  `targetPath`, and an absolute `expectedWatchedSavePath`;
- `repository.replacement.resolve` with that lifecycle `operationId` and a
  `commit` or `rollback` decision;
- `repository.migrate` with one absolute `repoPath`, a prior opaque inspection
  ID, and the literal migration confirmation;
- `repository.migration.prepare` with one absolute source `repoPath`, a prior
  opaque inspection ID, the literal migration confirmation, one absolute
  opaque `snapshotPath`, and one App-owned absolute `stagingRootPath`;
- `repository.migration.commit` with no arguments, committing the currently
  prepared non-cancelable migration operation;
- `repository.rebuild` with one absolute `repoPath`;
- `save.inspect` with one absolute canonical `savePath`;
- `session.open` with one absolute `repoPath` and an optional `access` policy
  of `readWrite` (default) or `readOnly`;
- `watcher.start`;
- `watcher.stop`; and
- `process.shutdown`.

A strict `repository.inspect` response projects History's safe compatibility result:
the repository status, required user action, opaque inspection ID, and allowed
capabilities. It does not contain config, Git, SQLite, or lock details.
Ordinary external and managed repository opens use the strict policy. Archived
read-only browsing and the Desktop migration preflight are the only advisory
callers; they use structural Git classification so a snapshot or read-only
session can proceed while the published snapshot reports any Git integrity
warning.
`repository.archive` is the Desktop-specific standalone relocation adapter. It
opens no Repo Session and performs no repository inspection. The Desktop sends
the exact source and target paths; History validates source/target directory and
symlink safety, excludes public History writers and watchers where the
repository control directory exists, and atomically renames the existing
directory to a collision-safe destination. It never observes the Watched Save,
checkpoints, copies a snapshot, edits Project Config, or initializes a
replacement.
`repository.replacement.prepare` is the narrow reversible replacement adapter.
The Desktop sends exact source and target paths. History revalidates the source,
eligible compatibility status, and expected Watched Save identity while holding
writer and watcher exclusions, then moves the source atomically to a
collision-safe destination and retains the leases. The sidecar holds one
prepared operation in memory until
`repository.replacement.resolve`; terminal resolve responses are replayed for
duplicate requests without repeating a move. `commit` retains the destination
and `rollback` moves it back. Abnormal sidecar exit releases leases without
rollback, leaving directories for Desktop discovery. The caller-owned
replacement directory is never touched by History.
`repository.migrate` returns History's safe migration result, including an
explicit stale-inspection or confirmation rejection when applicable. Migration
results also report `sourceState` (`unchanged`, `migrated`, or `unknown`) and
`snapshotState` (`notCreated` or a retained repository snapshot path). A result may also
report `cleanupFailure: "leaseReleaseFailed"`; this is a separate lifecycle
warning and does not replace the source or snapshot state. The
sidecar never evaluates repository versions or carries out migration itself.
`repository.migration.prepare` calls History's public migration Interface and
returns either a verified published snapshot
with its actual collision-adjusted path, canonical directory digest, and
optional advisory Git integrity warning, or a safe rejection/failure. The
sidecar holds the History operation lease until `repository.migration.commit`
is received. Desktop reports the snapshot path and warning before sending that
commit command. A snapshot failure prevents migration; a later migration
failure does not remove a published snapshot. The sidecar refuses shutdown
while a prepared operation is held. If the process instead receives EOF or a
termination signal after preparation, its internal cleanup releases that
History lease; this is lifecycle cleanup, not a user cancellation or retry
command.
`repository.rebuild` calls only History's public Semantic Read Model rebuild
workflow. History decides whether rebuilding is currently permitted and holds
its write serialization. A successful response returns rebuild counts and the
post-rebuild safe repository status—status, required action, and capabilities—
without an inspection ID or persistence details. Rebuild never rewrites
canonical Git Raw Save Observation history.

`repository.import` copies an accepted external repository without changing
the source, rebuilding its read model, or starting a watcher. History excludes
ephemeral read-model and lease files, verifies the source and published copy,
and publishes to a collision-safe path. The result includes the source status
(`ready`, `rebuildRequired`, `legacyConfig`, or `migrationRequired`) and the
published snapshot when copying succeeds. Lease cleanup is reported as the
structured `cleanupFailure: "leaseReleaseFailed"` warning without removing the
source or published copy. Desktop preserves that warning if publication-path,
post-copy status/name, or sidecar shutdown handling fails after a copy; a later
Desktop status failure retains the published copy for inspection or recovery.

`save.inspect` is a stateless Core adapter, not a History or Repo Session
operation. It repeats regular-file/readability validation immediately before
reading and uses Core's public Encoded Save decoder regardless of filename or
extension. Its result is exactly one of `save.inspected` with decoded JSON,
`save.invalidFile`, or `save.decodeFailed`; it never returns a path or encoded
bytes. It creates no repository, Git data, SQLite data, watcher, or session.

A process may open at most one Repo Session. A successful `session.open`
response is emitted after authenticated loopback HTTP is ready and while the
watcher remains inactive. Opening is refused unless Repo Session's History
compatibility inspection is `ready`:

```json
{
  "protocolVersion": "<protocol-version>",
  "kind": "response",
  "requestId": "open-1",
  "ok": true,
  "result": {
    "type": "session.opened",
    "access": "readOnly",
    "connection": {
      "endpoint": "http://127.0.0.1:49152",
      "bearerToken": "<in-memory credential>"
    }
  }
}
```

This is the credential's only protocol disclosure. The token is not repeated
in events, later responses, diagnostics, command arguments, or the endpoint
URL. History and watcher status data remain on the authenticated Local HTTP
Interface; the process protocol does not duplicate them.

`access` is selected by Desktop lifecycle policy, not by History inspection.
For `readOnly`, the sidecar opens a read-only Repo Session: compatible legacy
and migration-required archive candidates may be admitted, watcher controls,
rebuild/migration paths, and Local HTTP checkpoint and in-place restore
requests are rejected, while all read routes and exact Encoded Save export
remain available.

The current event types are:

- `process.ready`;
- `watcher.observation`, projected to cause, outcome, and safe outcome details;
- `watcher.failed`, without a raw error; and
- `session.failed`, without a raw error.

`mutation.activity` projects only the mutation class (`manualCheckpoint`,
`inPlaceRestore`, `repositoryMigration`, `managedInitialization`,
`managedReplacement`, `repositoryImport`, or `repositoryRebuild`) and
`started` or `finished`. It
contains no request body, save path, commit reference, or result. Desktop uses
it solely to reject a normal replacement or exit while the admitted mutation
is active; Repo Session retains admission and drain ownership.

The sidecar never forwards repository paths, Watched Save paths, Semantic Event
payloads, commit references, or raw exception messages in events.

## Shutdown and exit classification

`process.shutdown` first calls the public Repo Session shutdown operation. Its
`process.shutdownComplete` response is written only after HTTP admission is
closed and admitted HTTP and watcher work has drained. The process then flushes
any buffered events and exits naturally with status zero.

A caller classifies shutdown as requested and graceful only when both the
matching `process.shutdownComplete` response and exit status zero are observed.
EOF, a signal, output failure, or a session-fatal failure has no matching
acknowledgment and follows a nonzero or signal exit path.

Desktop has one sidecar supervisor as the exclusive stdout reader. It
demultiplexes responses by request ID, accepts safe lifecycle events, drains
stderr, and supervises child exit. EOF, a nonzero exit, malformed protocol
output, or `session.failed` invalidates the connection. Only an explicit reopen
of the in-memory selected repository is available afterwards, and it opens with
watching inactive; no watcher or mutation is retried automatically.

Unknown commands return `unknown_command`; incompatible versions return
`unsupported_protocol_version`; invalid JSON, framing, or envelopes return
`invalid_message`. These failures do not execute a Repo Session operation.
