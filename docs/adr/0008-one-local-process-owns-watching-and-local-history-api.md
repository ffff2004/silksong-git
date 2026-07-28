# Use one Repo Session for watching and the local history API

We decided that one Repo Session owns file watching, raw observation commits, Semantic Read Model updates, and the local HTTP endpoints for one Watched Save. Web UI frontend serving is intentionally separate from that session: during development it can be Vite, and later it can be static hosting, a small helper process, or another frontend-serving mechanism.

The Repo Session is a singleton per Save History Repository. Its History watcher lease holds a long-lived repository-scoped watch lock, separate from the short-lived write lock used for Git and SQLite mutations, so a second watcher cannot start for the same repository while Offline Commands can still serialize legitimate writes.

CLI commands for history, diff, search, and restore can also run as Offline Commands that read the Save History Repository and SQLite read model directly, but no second Repo Session should independently watch the same save and write Git or SQLite, because that would create avoidable locking and race conditions.

Manual checkpoints are allowed as user-invoked single-shot writes. They do not create a second watcher: they call the same `packages/history` observation path and must acquire the same Save History Repository write lock before mutating Git artifacts or SQLite.

The local HTTP endpoints served by the Repo Session are adapters over the `packages/history` Interface. They must not directly query SQLite or run Git operations; they call history functions such as `queryHistory`, `diffCommits`, `searchSemanticEvents`, `restoreEncodedSave`, and `observeSave`, so Web local mode and CLI workflows share the same behavior. The session runtime and executable HTTP contract live above History; this decision does not introduce a watcher-independent session lifecycle.

The Web UI is a client of the local HTTP Interface. It enables local-history features only when connected to a compatible endpoint; without that endpoint it remains in Static Web Mode. The frontend's serve mechanism must not become part of the single-writer invariant.

ADR-0018 refines this decision with the first-version HTTP security boundary,
versioned contract, bearer authentication, and polling model. ADR-0020
supersedes this ADR's singleton-session and atomic watcher/server lifecycle:
only watching is singleton, while reader HTTP opens independently.
