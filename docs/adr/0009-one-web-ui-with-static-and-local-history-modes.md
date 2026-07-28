# Use one shared Web presentation with build-specific runtime capabilities

We decided to keep one shared Web presentation that is composed with an
explicit Runtime Capabilities implementation at each application entry point.
The Browser build injects capabilities for Static Web Mode only. A Desktop
build injects the ability to obtain an in-memory Repo Session endpoint and
bearer token, enabling Local History Web Mode through the existing authenticated
local HTTP client. Feature code does not infer its runtime from Tauri globals or
other ambient environment checks.

Static Web Mode preserves the browser-only Encoded Save and Decoded Save upload
workflow and does not access Git, SQLite, or the local filesystem. The Browser
build does not expose Local History navigation or a manual endpoint/token
connection control. Preserved Local History URLs render an explicit
browser-unavailable state. Desktop obtains connection information through its
injected capability; endpoint and bearer token remain in memory and are not
written to browser storage or URLs.

The modes remain mutually exclusive. A successful Desktop connection clears
any uploaded Static Save. Disconnecting clears Repo Session Save State and
returns to an empty current-save view rather than retaining two competing Save
State sources. The one Save Store continues to identify its source as `static`,
`localLatest`, or `localCommit`.

The first Web UI keeps the existing Progress, Map, and Raw Save Data views instead of introducing a combined Current Save view. Local History Web Mode defaults those views to the latest committed Raw Save Observation. A History selection fixes them to one canonical immutable commit through a `commit` URL query parameter; moving between the three views preserves that selection. A second-row Topbar banner makes historical selection explicit and provides Back to Latest. Watcher revisions refresh latest state but never replace an explicitly selected historical commit.

Local History Web Mode adds History, Diff, and Watcher views. History combines Semantic Event browsing and structured search in one Events view, while a sibling Observations view exposes complete Raw Save Observation history. The UI calls history behavior when no search fields are submitted and search behavior when fields are present; the underlying `queryHistory` and `searchSemanticEvents` Interfaces remain distinct. Events are grouped by commit. Export and confirmed in-place restore are commit actions inside History rather than separate views. Diff remains a separate two-commit workflow, with commit selection initiated from History when convenient. Manual Checkpoint belongs to Watcher.

Semantic Diff reuses the Progress visual language behind an explicit rendering seam rather than mutating the application Save Store. It defaults to changed items, can optionally show unchanged items, and visually emphasizes changes. A separate lazy Monaco view compares the two Decoded Save JSON values. Static Web Mode exposes only Progress, Map, and Raw Save Data. Desktop Local History navigation is visible only while connected; a preserved Local History URL renders a connection-required state until then.
