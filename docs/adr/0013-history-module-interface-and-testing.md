# Expose a small history module interface and test it through behavior

We decided that `packages/history` exposes a small deep Module interface for save-history workflows: `initSaveHistory`, `observeSave`, `rebuildSemanticReadModel`, `queryHistory`, `diffCommits`, `searchSemanticEvents`, `restoreEncodedSave`, and `startLocalHistoryProcess`. Git, SQLite, file watching, config loading, and local HTTP details are implementation concerns or internal adapters behind this interface.

History tests should be integration-style and use the public history interface with temporary directories, a real Git repository, and a real SQLite read model. Mocks should be limited to true system boundaries such as time and watcher event delivery. The first TDD tracer bullet should verify that `initSaveHistory` plus `observeSave` creates a raw observation that `restoreEncodedSave` can restore byte-for-byte; later vertical slices should add semantic diff/search behavior and capture-policy behavior.

The SQLite schema is not part of the external Interface. CLI and Web callers must use history query functions such as `queryHistory`, `diffCommits`, and `searchSemanticEvents`; table layout, indexes, and migrations are implementation details of `packages/history` and can change as long as those observable query behaviors remain stable.

`searchSemanticEvents` accepts structured query fields as its stable Interface. Fuzzy free-text search may exist as a convenience adapter for CLI use, but Web and programmatic callers should express searches through structured event fields.
