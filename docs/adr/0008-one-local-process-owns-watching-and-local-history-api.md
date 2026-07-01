# Use one local process for watching and the local history API

We decided that one Local History API Process owns file watching, raw observation commits, Semantic Read Model updates, and the local HTTP endpoints for one Watched Save. Web UI frontend serving is intentionally separate from that process: during development it can be Vite, and later it can be static hosting, a small helper process, or another frontend-serving mechanism.

CLI commands for history, diff, search, and restore can also run as Offline Commands that read the Save History Repository and SQLite read model directly, but no second process should independently watch the same save and write Git or SQLite, because that would create avoidable locking and race conditions.

The local HTTP endpoints served by the Local History API Process are adapters over the `packages/history` Interface. They must not directly query SQLite or run Git operations; they call history functions such as `queryHistory`, `diffCommits`, `searchSemanticEvents`, `restoreEncodedSave`, and `observeSave`, so Web local mode and CLI workflows share the same behavior.

The Web UI is a client of the local HTTP Interface. It enables local-history features only when connected to a compatible endpoint; without that endpoint it remains in Static Web Mode. The frontend's serve mechanism must not become part of the single-writer invariant.
