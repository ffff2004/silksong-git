# Local History Watch Process Architecture

The Local History Watch Process is the long-running owner for one Watched Save
and its Save History Repository. It subscribes to file changes, schedules
observations, calls the public History behavior that commits Raw Save
Observations and updates the Semantic Read Model, and may own one local HTTP
listener. Its live public contract is the package-root
[`@silksong-git/history` Interface](../../packages/history/src/index.ts).

This process boundary follows
[ADR-0008](../adr/0008-one-local-process-owns-watching-and-local-history-api.md).
Observation persistence belongs to the
[Save History Module](save-history-module.md), not to a second watcher-specific
write path.

## Ownership and Locks

Only one Local History Watch Process may own a Save History Repository at a
time. Startup acquires the repository's `watch.lock` before attaching the watch
backend. The process holds that lock until its shutdown cleanup releases it. A
conflicting lock stops a second process before it starts watching. The lock
contains diagnostics, but the current implementation does not automatically
decide that an existing lock is stale or remove it. Shutdown waits for active
filesystem-change work, but has a known exception for an already-started
deferred observation described under [Current Implementation Gaps](#current-implementation-gaps).

The two repository locks have different scopes:

| Lock         | Lifetime                            | Responsibility                                                                                                                                                 |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch.lock` | One complete watch-process lifetime | Enforces singleton ownership of watching and, when enabled, the listener lifecycle for one repository.                                                         |
| `write.lock` | One History mutation transaction    | Serializes an observation's Git and SQLite work, rebuilds, and in-place restore with watcher work and Offline Commands. It is released after each transaction. |

Holding `watch.lock` therefore does not exclude an Offline Command. Manual
checkpoints, rebuilds, restores, and watcher observations share `write.lock`
and wait for one another when they mutate repository state. The process does
not expose or reimplement the Git, SQLite, Capture Policy, or restore work
inside that lock.

## Startup and Configuration Snapshot

Startup reads Project Config once, then uses that snapshot's Watched Save path
and Capture Policy until the process exits. Editing Project Config does not
reconfigure a running process; it must be restarted. One-shot Offline Commands
continue to read the current Project Config when they run.

After acquiring `watch.lock`, startup attaches the file watch backend. If HTTP
is requested, it then starts the listener in the same process. Only after the
requested components are ready does the process emit its structured `started`
event. Failure to acquire process ownership or start either component aborts
startup and releases resources already acquired.

The backend is attached before the initial observation, so a change during
startup is not missed by attaching too late. The current implementation then
performs a startup observation directly. It does not yet run the stability
probe required by the intended design before that startup read; startup
stability must not be treated as a current guarantee.

## Event-to-Observation Scheduling

A filesystem event is a scheduling signal, not a Raw Save Observation and not
a commit boundary. Current change handling follows this sequence:

1. If no change pass is active, the process starts one. Further filesystem
   events during that pass set a dirty bit rather than starting concurrent
   change observations.
2. The pass waits until the Watched Save has the same size and modification
   time across bounded probes. An inability to stat the file or reach stability
   produces a non-committed Watcher Error for that pass.
3. Once stable, the process acquires History's short-lived `write.lock` and
   invokes the shared observation path with the startup Project Config snapshot
   and watcher trigger.
4. History returns `committed`, `skipped`, or `watcherError`. The process emits
   an observation event, updates its coarse status, and schedules follow-up
   work when required.
5. If the dirty bit was set, one more pass probes and reads the then-current
   Watched Save. This repeats serially while changes keep arriving.

The process never treats event payload bytes as authoritative: each pass reads
the current stable Watched Save through History. This single-flight dirty-bit
loop coalesces bursts while preserving a later pass for a change that arrives
during active work.

The configured `debounceWriteMs` is exposed in the startup event and watcher
status, but the current runtime does not yet delay real file events by that
duration. Debounced change scheduling is therefore not a current capability.

### Deferred observations

When History skips a watcher observation because of the Minimum Commit
Interval, it supplies the next allowed time. The process keeps at most one
deferred timer. When that timer fires, it probes the current Watched Save for
stability and starts an observation with cause `deferred`; it does not reuse
bytes from the earlier event. If the bytes have returned to the last committed
state, History can skip that later observation as unchanged.

The deferred timer is separate from the filesystem-change dirty-bit loop.
Their stability work can overlap, but all mutations still serialize through
`write.lock`. The current implementation does not merge later filesystem
events into, or reschedule, an already pending deferred timer.

## Observation Outcomes and Failures

History owns the meaning of an observation result. In outline, `committed`
records a Raw Save Observation and attempts its incremental Semantic Read
Model update, while `skipped` leaves Git and SQLite unchanged. The full
transaction and the distinction between an Unrecognized Schema Observation
and a decode failure are documented in the
[Save History Module](save-history-module.md).

The process separates recoverable candidate-save failures from fatal ownership
or component failures:

| Failure class                 | Current examples                                           | Process effect                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Recoverable Watcher Error     | read failure, decode failure, stability timeout            | No Raw Save Observation is committed for that pass. Status and an observation event record the error; later changes may still be observed. |
| Fatal process failure         | watch backend failure, unrecoverable HTTP listener failure | A fatal event is emitted and graceful shutdown begins.                                                                                     |
| Startup failure               | existing `watch.lock`, backend or listener start failure   | The start call fails and acquired process resources are cleaned up; no running process is returned.                                        |
| Nonfatal HTTP request failure | a classified server-side request or handler failure        | A sanitized `httpRequestError` event may be emitted; the listener and watcher continue.                                                    |

A Watcher Error describes one candidate save read, not process ownership. A
decoded but unrecognized save is instead a committed Unrecognized Schema
Observation and is not a Watcher Error.

## Structured Events and Status

Callers may omit the event listener. When supplied, it receives structured
`started`, `observation`, `httpRequestError`, `fatalError`, `stopping`, and
`stopped` events. The CLI is an Adapter over those events; it does not own a
second watcher state machine.

The process also exposes a coarse current status snapshot containing:

- `idle`, `pending`, or `observing` activity;
- the repository and Watched Save paths;
- the startup time and Capture Policy snapshot;
- an `observationRevision` incremented after every completed observation
  result, including skips and Watcher Errors; and
- only the latest compact observation summary, when one exists.

This status is not a lossless event stream or a durable audit log. Persistent
changes belong to History queries. Exact status and event types remain owned
by the package-root Interface rather than this document.

## Optional Local HTTP Lifecycle

HTTP is an optional component of the same Local History Watch Process. Enabling
it does not create a second watcher, persistence owner, or mutation queue. The
watch backend and requested listener must both start successfully before the
process reports `started`; a listener startup failure cleans up the backend and
releases `watch.lock`. An unrecoverable listener runtime failure is fatal to the
whole process, while an individual request failure is not.

Route handlers adapt requests to public History workflows. Exact routes,
authentication, compatibility discovery, wire schemas, and error responses
belong to the [Local HTTP API Reference](../reference/local-http-api.md) and its
executable contract, not to this process architecture. Frontend serving also
remains outside the process.

## Graceful Shutdown

Shutdown is idempotent and emits `stopping` before cleanup and `stopped` after
the watch lock is released. The current ordering is:

1. mark the process stopped and cancel its pending deferred timer;
2. when HTTP is enabled, stop accepting new HTTP connections and wait for
   active handlers to finish;
3. stop the file watch subscription so no new change work is accepted;
4. wait for the active filesystem-change loop, including any observation that
   loop already started inside History, to finish;
5. release `watch.lock` and emit `stopped`.

The process does not hard-cancel work in the filesystem-change loop that may be
mutating Git, SQLite, or the Watched Save. A stability probe running in that
loop is likewise awaited. A pending deferred timer is cancelled, but an
already-started deferred stability probe or observation is not tracked or
awaited by shutdown. Consequently, that work can continue after `watch.lock`
is released and `stopped` is emitted. Waiting for all active observation work
before releasing resources remains the lifecycle target in
[ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md), not a guarantee
of the current runtime.

## Current Implementation Gaps

The previous design describes scheduling and shutdown guarantees that the live
runtime does not currently provide: applying `debounceWriteMs` to real file
changes, stability-probing the startup observation, and waiting for an
already-started deferred observation before releasing process resources. It
also describes merging later events into a pending deferred opportunity, while
the current deferred timer remains independent of the change loop. These are
implementation gaps, not current architecture guarantees. The documentation
migration's
[classification ticket](https://github.com/ffff2004/silksong-git/issues/11)
owns their disposition.
