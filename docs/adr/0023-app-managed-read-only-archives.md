# Use App-managed placement for read-only repository archives

We decided that the Desktop App will classify a direct child of its managed
`archives/` root as an Archived Repository. Archive placement is an App-only,
read-only lifecycle classification: it does not alter Project Config, assert
that the repository is an old save generation, or require durable provenance
metadata. The App may inspect, browse, diff, search, and export a compatible
Archived Repository, but every App path rejects watcher ownership, checkpoint,
relink, In-Place Restore, durable migration, and Semantic Read Model rebuild.
This is capability enforcement across Desktop, its sidecar/HTTP adapters, and
History workflows, not merely hidden UI controls. The App does not change
filesystem permissions; users retain normal filesystem control of their data.

The App can create archives in exactly three Desktop-managed workflows. A user
may archive a direct child of the mutable `repositories/` root by moving it
atomically to `archives/`. Reinitializing the same Watched Save path archives
the prior Managed Repository before initializing the replacement; once that
move succeeds, a later replacement failure removes only the newly created
directory and leaves the old archive in place. Before a confirmed durable
Project Config or Git-layout migration of a Managed Repository, the App
creates an Archive Snapshot and does not begin migration unless that snapshot
succeeds. CLI migration remains outside this App-managed archive mechanism and
uses its own existing recovery behavior.

History owns creating a consistent Archive Snapshot through a public Interface:
it coordinates repository ownership, writes to staging, and validates the copy
before the App atomically publishes it under `archives/`. Validation compares a
canonical SHA-256 Merkle digest of the source and staging directory trees,
checks Git integrity when applicable, and re-inspects the copy to ensure that
its compatibility result has not degraded. A migration source may itself be
`migrationRequired`; snapshot validity preserves that status rather than
requiring `ready`. Successfully published migration snapshots are retained
whether migration succeeds or fails; the App has no automatic retention or
deletion policy.

For an identifiable repository, archive moves and snapshots require no active
App work, the History write serialization, and no externally owned watcher.
The App never terminates an external CLI watcher to proceed. A user may also
archive an unrecognizable direct-child residual directory after an explicit
danger confirmation, because History cannot coordinate a directory that it
cannot inspect. Its later archive listing continues to show the inspection
failure rather than claiming that it is usable history.

Archive destination names use
`<original-repo-name>--<reason>-<local-time-with-ms-and-offset>`, where
`reason` is one of `user`, `reinitialize`, or `pre-migration`. Atomic collision
counters avoid overwriting an existing entry. Names are presentation and
uniqueness aids only; code never parses them for identity or capability.
The App does not offer archive reactivation, permanent archive deletion, or
archive moves. It scans the managed roots rather than maintaining a registry.

This refines the supported-use boundary in ADR-0005 without changing its core
meaning: each mutable Managed Repository still represents one Watched Save,
and duplicate canonical Watched Save checks apply only within `repositories/`.
Archived Repositories and Archive Snapshots may share that historical path and
are intentionally excluded from mutable-path conflict detection. External
repositories are neither moved nor copied into App management; if a user moves
an archive outside the managed root, the App no longer assigns it archive
capabilities.
