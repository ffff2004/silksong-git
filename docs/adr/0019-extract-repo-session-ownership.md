# Extract Repo Session ownership above History

We decided to move the long-running watch runtime, loopback HTTP Adapter,
executable HTTP contract, browser-safe wire contract, and OpenAPI generator
from History into `packages/repo-session`. Repo Session depends on History and
uses only its package-root workflows and watcher lease. History remains the
owner of Project Config, locks, Git, SQLite, observations, queries, export, and
restore; it does not re-export Repo Session.

This initially preserved the then-current atomic lifecycle. ADR-0020 supersedes
that lifecycle: opening now starts mandatory reader HTTP, and watching is a
separately startable and stoppable capability. The package ownership and
dependency direction decided here remain accepted.

The browser imports only the `@silksong-git/repo-session/http-wire` subpath.
That subpath has no Node, Hono, or History runtime import; handlers and the
Node-only executable contract remain outside the browser graph. HTTP handlers
continue to call public History workflows, so this ownership move creates no
second persistence path.
