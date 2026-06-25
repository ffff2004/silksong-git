# Use one Web UI with static and local history modes

We decided to keep one Web UI that can run in Static Web Mode or Local History Web Mode. Static Web Mode preserves the current browser-only upload workflow and does not access Git, SQLite, or the local filesystem, while Local History Web Mode connects to local endpoints served by the Local History Process for watcher status, history, semantic diff, search, and restore/export features.

The first Web UI view set keeps the current tracker capabilities as the Current Save view and adds Local History Mode views for History, Diff, Search, Watcher status, and Restore/Export. Static Web Mode only exposes Current Save behavior; Local History Web Mode exposes history and restore workflows through the local HTTP adapter over `packages/history`.
