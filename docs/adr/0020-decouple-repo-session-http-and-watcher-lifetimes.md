# Decouple Repo Session HTTP and watcher lifetimes

We decided that opening a Repo Session always starts authenticated
IPv4-loopback HTTP for one Save History Repository while leaving watching
inactive. The endpoint and per-session credential are mandatory, stable for the
session lifetime, and independent of later watcher start and stop operations.
Only an active watcher holds History's `watch.lock`; multiple reader sessions
may coexist with it.

This refines ADR-0008, ADR-0018, and ADR-0019 where they made watcher ownership,
backend attachment, and optional HTTP one atomic startup lifetime. Their module,
security, authentication, executable-contract, and dependency decisions remain
accepted. The public entry is named `openRepoSession` because successful return
means reader HTTP is ready, not that automatic observation has begun.

The Repo Session Interface stays repository-scoped and small: identity and
mandatory HTTP connection data, watcher status, independent start/stop watching,
and session stop. Watcher status is a discriminated lifecycle snapshot. Data
from the watcher lease's Project Config snapshot appears only while that lease
is active or draining; session-scoped observation revision and latest summary
survive watcher restarts for coherent polling.

Watcher lifecycle operations linearize internally and same-state operations are
idempotent. Start acquires History's public watcher lease, attaches the backend,
then performs the startup observation. Partial start failure releases every
acquired watcher resource but does not close HTTP. Runtime backend failure has
the same watcher-only boundary. Listener failure remains session-fatal.

HTTP continues to adapt only public History Interfaces. Read workflows do not
need the Watched Save or watcher ownership. Manual Checkpoint and In-Place
Restore likewise do not need watcher ownership; History's short-lived
`write.lock` remains their cross-process serialization boundary.

Session shutdown first closes new HTTP admission and freezes watcher scheduling.
It explicitly drains admitted History handlers and started observations before
releasing watcher ownership and completing listener close. Handler tracking is
below response timeout and disconnect boundaries, because ending response
delivery must not cancel an admitted mutation.

We retain `watch start` as a CLI convenience implemented as open followed by
immediate watcher start. HTTP therefore always exists in that process. Its
`--http` option only asks the CLI output Adapter to disclose endpoint and token;
`--port` retains its existing requirement for `--http`. Credentials are not
placed in general Repo Session events or logs.
