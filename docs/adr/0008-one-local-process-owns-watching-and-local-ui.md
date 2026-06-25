# Use one local process for watching and the local Web UI

We decided that one Local History Process owns file watching, raw observation commits, Semantic Read Model updates, and the local Web UI. CLI commands for history, diff, search, and restore can also run as Offline Commands that read the Save History Repository and SQLite read model directly, but no second process should independently watch the same save and write Git or SQLite, because that would create avoidable locking and race conditions.

The local HTTP endpoints served by this process are adapters over the `packages/history` interface. They must not directly query SQLite or run Git operations; they call history functions such as `queryHistory`, `diffCommits`, `searchSemanticEvents`, `restoreEncodedSave`, and `observeSave`, so Web local mode and CLI workflows share the same behavior.
