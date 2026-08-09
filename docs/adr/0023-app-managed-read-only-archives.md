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

The App can create archives only through three Desktop-managed workflows: a
user-directed archive, reinitializing a Watched Save, and a durable migration.
Each workflow preserves the existing archive if its later operation fails.
CLI migration remains outside this App-managed archive mechanism and uses its
own recovery behavior.

History owns creating a consistent Repository Snapshot through its public
migration Interface. Desktop selects the opaque snapshot destination and may
allow a durable migration to write only after that snapshot succeeds and is
atomically published under `archives/`. The published snapshot is retained as
an Archived Repository whether migration succeeds or fails; the App has no
automatic retention or deletion policy. Issue #47 owns the precise
confirmation, validation, and mutation-lifecycle behavior for this workflow.

Archive placement, rather than a name or registry entry, determines archive
capabilities. The App does not offer archive reactivation, permanent archive
deletion, or archive moves. It never terminates an externally owned CLI watcher
to perform archive work.

This refines the supported-use boundary in ADR-0005 without changing its core
meaning: each mutable Managed Repository still represents one Watched Save,
and duplicate canonical Watched Save checks apply only within `repositories/`.
Archived Repositories and Archive Snapshots may share that historical path and
are intentionally excluded from mutable-path conflict detection. External
repositories are neither moved nor copied into App management; if a user moves
an archive outside the managed root, the App no longer assigns it archive
capabilities.
