# Repo Session Architecture

A Repo Session is the long-running reader process for one Save History
Repository. Opening first asks History to inspect repository compatibility. It
starts mandatory authenticated IPv4-loopback HTTP for a `ready` repository, or
for a `legacyConfig`/`migrationRequired` repository when the caller explicitly
selects `readOnly`; migration, rebuild, invalid-candidate, and newer-app
actions are otherwise resolved through the History Interface before opening.
Once opened, it leaves watching inactive. The same session may start and stop watching without
changing its repository, endpoint, or bearer token. Its live public contract is
the package-root
[`@silksong-git/repo-session` Interface](../../packages/repo-session/src/index.ts).

This lifecycle follows
[ADR-0020](../adr/0020-decouple-repo-session-http-and-watcher-lifetimes.md).
Persistence, locks, and restore remain owned by the
[Save History Module](save-history-module.md).

## Session and Watcher Ownership

Opening a session allocates a fresh 256-bit bearer credential and starts its
HTTP listener before returning. The listener endpoint and credential remain
stable until session shutdown. Opening does not read the Watched Save, attach a
watch backend, or acquire `watch.lock`, so readers can coexist with another
process's watcher and can browse history when the Watched Save is absent.

Watching is an independent repository-scoped capability. `startWatching`
acquires History's Save History Watcher lease, attaches the backend, reports
the active watcher, and performs the startup observation. `stopWatching`
freezes scheduling, cancels opportunities that have not started, stops the
subscription, drains a started probe or observation, and then releases the
lease. The listener is unchanged by either operation.

Same-state start and stop calls are idempotent. Concurrent lifecycle calls are
linearized inside the session. A failed acquisition, backend attachment, or
startup observation setup cleans up every partially acquired watcher resource,
returns watcher status to inactive, and leaves reader HTTP alive. A conflicting
external lease therefore prevents watching, not opening or using the session;
the caller may retry after the owner releases it.

The repository locks retain distinct scopes:

| Lock         | Lifetime                         | Responsibility                                                                                             |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `watch.lock` | One active watcher lease         | Ensures only one automatic watcher owns a Save History Repository. Reader sessions do not hold this lock.  |
| `write.lock` | One History mutation transaction | Serializes observations, rebuilds, Manual Checkpoints, and In-Place Restore across processes and adapters. |

HTTP handlers call only public History workflows. Manual Checkpoint and
In-Place Restore therefore remain available while watching is inactive or an
external watcher exists; they serialize with all other writers through
History's `write.lock`.

## Watcher Status

The polling status is a discriminated lifecycle snapshot: `inactive`,
`starting`, `running`, or `stopping`. Session-scoped `observationRevision`
remains monotonic across watcher restarts and the latest compact observation,
when present, remains available while inactive. Active-only data—the Watched
Save path, Capture Policy snapshot, watcher start time, and scheduler
activity—is exposed only while running or stopping. This prevents a reader or
not-yet-acquired watcher from claiming configuration it does not own.

The revision increments after every completed observation result, including
skips and Watcher Errors. It is a polling change signal rather than a lossless
event stream or durable audit log; persistent results belong to History
queries.

## Observation Scheduling

Starting watching snapshots Project Config through the History watcher lease.
The backend is attached before the startup observation so changes during
startup are not missed. Startup and later opportunities use the same bounded
file-stability probe before History reads the Watched Save.

A filesystem event is a scheduling signal, not a commit boundary. The session
keeps at most one active stability-probe/observation path and one pending timed
opportunity. Real changes use trailing debounce. A change arriving during
active work is retained for a later opportunity. Minimum Commit Interval skips
schedule one deferred read no earlier than both History's next-allowed time and
the latest change's debounce deadline; deferred work reads current bytes rather
than retaining an earlier payload.

History owns committed, skipped, and Watcher Error meanings. A recoverable read,
decode, or stability failure completes one observation opportunity and permits
later changes. A fatal watch-backend failure stops and releases only the watcher,
leaving reader HTTP available. A fatal listener failure remains session-fatal.
Individual HTTP request failures affect neither component.

## HTTP Admission and Shutdown

The exact routes, authentication, wire schemas, and error mapping belong to the
[Local HTTP API Reference](../reference/local-http-api.md). The listener does
not serve frontend assets and exposes no watcher lifecycle mutation routes.

Session shutdown is idempotent and ordered around admitted work:

1. close HTTP admission and start closing the listener so new work is rejected;
2. freeze watcher scheduling and cancel unstarted opportunities;
3. stop the watch subscription;
4. explicitly drain admitted HTTP handler promises and every started watcher
   probe or observation;
5. release watcher ownership, finish listener close, and complete shutdown.

The session tracks History handler work below the response-timeout boundary.
Consequently, a client disconnect or timeout can end response delivery without
cancelling a mutation that entered History, and shutdown still waits for that
work. It never hard-cancels an operation that may be changing Git, SQLite, or
the Watched Save.
