# Split the fork into core, history, CLI, and Web workspace packages

We decided to restructure the fork as a pnpm workspace with separate packages for the reusable semantic core, the history layer, the CLI, and the Web app. `packages/core` owns decoding, parsing, semantic snapshots, and semantic diffing without DOM, Git, or SQLite dependencies; `packages/history` owns the Save History Repository, watcher, Git adapter, and SQLite Semantic Read Model; `apps/cli` owns command parsing and terminal output; `apps/web` owns the Vite Web UI in static and local history modes.

This keeps the semantic core as the main deep Module used by both the CLI and Web UI, while keeping Git, SQLite, filesystem watching, and local HTTP behavior out of the static browser build.
