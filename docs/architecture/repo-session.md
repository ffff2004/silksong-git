# Repo Session Architecture

The Repo Session is the long-running owner for one Watched Save
and its Save History Repository. It subscribes to file changes, schedules
observations, calls the public History behavior that commits Raw Save
Observations and updates the Semantic Read Model, and may own one local HTTP
listener. Its live public contract is the package-root
[`@silksong-git/repo-session` Interface](../../packages/repo-session/src/index.ts).

This session boundary follows
[ADR-0008](../adr/0008-one-local-process-owns-watching-and-local-history-api.md).
Observation persistence belongs to the
[Save History Module](save-history-module.md), not to a second watcher-specific
write path.

This extraction changes package ownership, not lifecycle scope. A Repo Session
starts by acquiring watcher ownership and stops by releasing it; it does not
yet represent a watcher-independent or query-only repository lifecycle.

## Ownership and Locks

Only one acquired Save History Watcher lease may own a Save History Repository
at a time. The Repo Session acquires that lease before attaching
the watch backend; the lease holds the repository's `watch.lock` until shutdown
cleanup releases it. A conflicting lease stops a second session before it starts
watching. The lock contains diagnostics, but the current implementation does
not automatically decide that an existing lock is stale or remove it. Shutdown
waits for every already-started observation path, including deferred work,
before releasing the lease.

The two repository locks have different scopes:

| Lock         | Lifetime                            | Responsibility                                                                                                                                                 |
| ------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watch.lock` | One acquired watcher-lease lifetime | Enforces singleton ownership of watching and, when enabled, the listener lifecycle for one repository.                                                         |
| `write.lock` | One History mutation transaction    | Serializes an observation's Git and SQLite work, rebuilds, and in-place restore with watcher work and Offline Commands. It is released after each transaction. |

Holding `watch.lock` therefore does not exclude an Offline Command. Manual
checkpoints, rebuilds, restores, and watcher observations share `write.lock`
and wait for one another when they mutate repository state. The session does
not expose or reimplement the Git, SQLite, Capture Policy, or restore work
inside that lock.

## Startup and Configuration Snapshot

Startup acquires a Save History Watcher lease, which reads Project Config once
and retains the snapshot's Watched Save path and Capture Policy until the
session exits. Editing Project Config does not reconfigure a running session;
it must be restarted. One-shot Offline Commands continue to read the current
Project Config when they run.

After acquiring the watcher lease, startup attaches the file watch backend. If
HTTP is requested, it then starts the listener in the same session. Only after
the requested components are ready does the session emit its structured
`started` event. Failure to acquire session ownership or start either component
aborts startup and releases resources already acquired.

The backend is attached before the initial observation, so a change during
startup is not missed by attaching too late. The initial observation then runs
the same bounded stability probe as every other candidate read before History
reads the Watched Save. Startup does not apply the real-change debounce: it is
already an explicit session-start observation.

## Event-to-Observation Scheduling

A filesystem event is a scheduling signal, not a Raw Save Observation and not
a commit boundary. One session-owned scheduling state machine accepts startup,
filesystem-change, and deferred-observation requests. It keeps at most one
active stability-probe/observation path and one pending timed opportunity.

1. Startup begins a stability probe immediately, without a real-change
   debounce.
2. A real filesystem event records the latest event time and schedules the
   candidate read after `debounceWriteMs`. Further events before that time
   replace the pending time, giving real changes trailing-debounce semantics.
3. An active probe or observation is never joined by a second path. A later
   event instead remains pending and is considered when the active path
   completes.
4. Every chosen opportunity waits until the Watched Save has the same size and
   modification time across bounded probes. An inability to stat the file or
   reach stability produces a non-committed Watcher Error for that opportunity.
5. Once stable, the session invokes the watcher lease's observation behavior
   with an explicit observation time. History acquires its short-lived
   `write.lock`, uses the lease's startup Project Config snapshot and watcher
   trigger, then returns `committed`, `skipped`, or `watcherError`; the session
   emits an observation event and updates its coarse status.

The session never treats event payload bytes as authoritative: every
opportunity reads the current stable Watched Save through History. The
single-flight scheduler therefore coalesces bursts while preserving a later
opportunity for a change that arrives during active work.

### Deferred observations

When History skips a watcher observation because of the Minimum Commit
Interval, it supplies the next allowed time. The scheduler retains one deferred
opportunity for that time. Its observation has cause `deferred`, probes the
current Watched Save for stability, and never reuses bytes from the earlier
event. If the bytes have returned to the last committed state, History can skip
that later observation as unchanged.

Later filesystem events merge into that same deferred opportunity. The eventual
read runs no earlier than both the minimum-interval time and the latest real
change's debounce deadline, so it uses the final current file state without
starting a parallel probe or repository writer. A deferred opportunity with no
later event runs at the supplied next-allowed time without an additional
debounce.

## Observation Outcomes and Failures

History owns the meaning of an observation result. In outline, `committed`
records a Raw Save Observation and attempts its incremental Semantic Read
Model update, while `skipped` leaves Git and SQLite unchanged. The full
transaction and the distinction between an Unrecognized Schema Observation
and a decode failure are documented in the
[Save History Module](save-history-module.md).

The session separates recoverable candidate-save failures from fatal ownership
or component failures:

| Failure class                 | Current examples                                           | Session effect                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Recoverable Watcher Error     | read failure, decode failure, stability timeout            | No Raw Save Observation is committed for that pass. Status and an observation event record the error; later changes may still be observed. |
| Fatal session failure         | watch backend failure, unrecoverable HTTP listener failure | A fatal event is emitted and graceful shutdown begins.                                                                                     |
| Startup failure               | existing `watch.lock`, backend or listener start failure   | The start call fails and acquired session resources are cleaned up; no running session is returned.                                        |
| Nonfatal HTTP request failure | a classified server-side request or handler failure        | A sanitized `httpRequestError` event may be emitted; the listener and watcher continue.                                                    |

A Watcher Error describes one candidate save read, not session ownership. A
decoded but unrecognized save is instead a committed Unrecognized Schema
Observation and is not a Watcher Error.

## Structured Events and Status

Callers may omit the event listener. When supplied, it receives structured
`started`, `observation`, `httpRequestError`, `fatalError`, `stopping`, and
`stopped` events. The CLI is an Adapter over those events; it does not own a
second watcher state machine.

The session also exposes a coarse current status snapshot containing:

- `idle`, `pending`, or `observing` activity;
- the repository and Watched Save paths;
- the startup time and Capture Policy snapshot;
- an `observationRevision` incremented after every completed observation
  result, including skips and Watcher Errors; and
- only the latest compact observation summary, when one exists.

This status is not a lossless event stream or a durable audit log. Persistent
changes belong to History queries. Exact status and event types remain owned
by the Repo Session package-root Interface rather than this document.

## Optional Local HTTP Lifecycle

HTTP is an optional component of the same Repo Session. Enabling
it does not create a second watcher, persistence owner, or mutation queue. The
watch backend and requested listener must both start successfully before the
session reports `started`; a listener startup failure cleans up the backend and
releases `watch.lock`. An unrecoverable listener runtime failure is fatal to the
whole session, while an individual request failure is not.

Route handlers adapt requests to public History workflows. Exact routes,
authentication, wire schemas, and error responses belong to the [Local HTTP API
Reference](../reference/local-http-api.md) and its executable contract, not to
this session architecture. Frontend serving also remains outside the session.

## Graceful Shutdown

Shutdown is idempotent and emits `stopping` before cleanup and `stopped` after
the watch lock is released. Its ordering is:

1. mark the scheduler stopped, reject new events, and cancel every timed
   opportunity that has not started;
2. when HTTP is enabled, stop accepting new HTTP connections and wait for
   active handlers to finish;
3. stop the file watch subscription so no new change work is accepted;
4. wait for the one active observation path, including a stability probe or
   History observation that began as startup, change, or deferred work, to
   finish;
5. release the Save History Watcher lease (and therefore `watch.lock`) and emit
   `stopped`.

The session does not hard-cancel started stability probes or work that may be
mutating Git, SQLite, or the Watched Save. It waits for that path before
releasing resources, while cancelling only opportunities that have not begun.
