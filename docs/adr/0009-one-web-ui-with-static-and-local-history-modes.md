# Use one Web UI with static and local history modes

We decided to keep one Web UI that can run in Static Web Mode or Local History Web Mode. Static Web Mode preserves the current browser-only upload workflow and does not access Git, SQLite, or the local filesystem, while Local History Web Mode connects to local endpoints served by a Local History API Process for watcher status, history, semantic diff, search, and restore/export features.

The Web UI frontend is decoupled from the Local History API Process. Its serve mechanism is not part of the mode decision: during development it can run through Vite, and later it can be served statically or by a small frontend-serving process. The mode decision is based on whether the frontend is connected to a compatible local HTTP endpoint.

The first Web UI view set keeps the current tracker capabilities as the Current Save view and adds Local History Mode views for History, Diff, Search, Watcher status, and Restore/Export. Static Web Mode only exposes Current Save behavior; Local History Web Mode exposes history and restore workflows through the local HTTP adapter over `packages/history`.
