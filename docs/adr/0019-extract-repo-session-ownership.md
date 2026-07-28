# Extract Repo Session ownership above History

We decided to move the long-running watch runtime, loopback HTTP Adapter,
executable HTTP contract, browser-safe wire contract, and OpenAPI generator
from History into `packages/repo-session`. Repo Session depends on History and
uses only its package-root workflows and watcher lease. History remains the
owner of Project Config, locks, Git, SQLite, observations, queries, export, and
restore; it does not re-export Repo Session.

This preserves the current `watch start` behavior and its atomic lifecycle:
starting a Repo Session acquires watcher ownership, attaches the watch backend,
and optionally starts HTTP before reporting readiness. It does not introduce a
query-only, watcher-independent, or separately startable watcher lifecycle.

The browser imports only the `@silksong-git/repo-session/http-wire` subpath.
That subpath has no Node, Hono, or History runtime import; handlers and the
Node-only executable contract remain outside the browser graph. HTTP handlers
continue to call public History workflows, so this ownership move creates no
second persistence path.
