# Keep the first CLI command set small and lifecycle-oriented

We decided that the first version of the CLI exposes lifecycle commands for the core workflows: `init`, `watch`, `snapshot`, `history`, `diff`, `search`, `restore`, `rebuild`, and `ui`. This covers setup, raw observation capture, one-off semantic mapping, semantic history browsing, event reverse lookup, restore, read-model rebuilds, and local Web UI launch without committing to an interactive TUI or broader multi-save workspace features.

`snapshot --save` is a semantic mapping command and does not write Git history. On success it exits `0` and prints a Semantic Snapshot. If decoding fails, it exits `2` and prints an error to stderr without JSON output. If decoding succeeds but the save schema is unrecognized, it exits `3` by default; with `--raw`, it may print the Decoded Save and schema status for debugging instead of a Semantic Snapshot.

History-oriented commands such as `history`, `diff`, and `search` default to human-readable text output, while `--json` produces stable machine-readable JSON. The JSON shapes are part of the CLI contract; the text formatting can evolve as long as it remains readable.

`search` supports structured query flags such as `--item-id`, `--label`, `--type`, and `--status-to` as the stable interface. A convenience `--event` free-text query can be provided for interactive use, but Web UI and other callers should prefer structured query fields rather than depending on fuzzy text behavior.
