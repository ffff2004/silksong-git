# Cover Web UI items and save summary metrics in semantic snapshots

We decided that a Semantic Snapshot covers the same recognizable item set used by the current Web UI data tables: `main`, `essentials`, `bosses`, `mini-bosses`, `completion`, `wishes`, `journal`, and `scenes`. It also includes selected Save Summary Metrics such as completion percentage, play time, rosaries, shell shards, and permadeath mode, so the CLI, local Web UI, and existing tracker views can share one semantic core while noisy metric events can still be hidden by Display Semantic Event Filters.
