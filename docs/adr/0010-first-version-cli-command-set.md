# Keep the first CLI command set object-grouped and lifecycle-oriented

We decided that the first version of the CLI is object-grouped and lifecycle-oriented: it should group commands by user-facing operation object while covering setup, raw observation capture, raw decoded-save inspection for debugging, one-off semantic mapping, semantic history browsing, event reverse lookup, restore, read-model rebuilds, starting the Local History API Process, and opening the local Web UI client.

Object grouping reduces the amount of implicit knowledge a user must remember. A user can first choose the object they are operating on, such as a Save History Repository, an Encoded Save, history, the watcher, or the local UI, and then choose the action for that object.

This keeps the first release focused on the core save-history workflow without committing to an interactive TUI, a broader multi-save workspace, or a general-purpose command tree before those workflows prove necessary. The grouping should follow the domain language in `CONTEXT.md` rather than internal package names such as `core`, `history`, or `read-model`.

The concrete first-version subcommands and flags are specified in `docs/save-history-design.md`. That document owns the implementation map for command syntax, error behavior, and test slices; this ADR owns the durable scope decision and contract limits.

Machine-readable JSON output is part of the CLI contract where a command supports it. Human-readable text output can evolve as long as it remains readable, because it is for interactive use rather than automation.

Structured query fields are the stable interface for search behavior. Free-text event search may exist as an interactive convenience, but Web UI and programmatic callers should not depend on fuzzy text behavior.
