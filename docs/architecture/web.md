# Web Architecture

The Web application is one shared Solid presentation composed with
build-specific Runtime Capabilities. The Browser entry point supports Static
Web Mode only. A Desktop entry point can additionally support Local History Web
Mode by injecting Repo Session connection delivery. The presentation and Save
State model remain shared; feature code does not detect Tauri or inspect runtime
globals. This follows
[ADR-0009](../adr/0009-one-web-ui-with-static-and-local-history-modes.md).

The Browser runtime is rooted at
[`main.tsx`](../../apps/web/src/main.tsx), while the first Desktop runtime is
rooted at [`desktop-main.tsx`](../../apps/web/src/desktop-main.tsx). Both
compose [`App.tsx`](../../apps/web/src/app/App.tsx) and use a hash router so
their static assets can host every view without server-side route handling.

## Module Boundary

The Web package owns rendering, navigation, browser interaction, connection
state, and the currently displayed Save State. It does not own decoding rules,
semantic mapping, history persistence, watching, Git, SQLite, or restore
execution.

Its two external dependencies have deliberately different roles:

- Static Web Mode calls the public
  [`@silksong-git/core` Interface](../../packages/core/src/index.ts) to decode,
  parse, and create a Semantic Snapshot in the browser. The
  [Semantic Core architecture](semantic-core.md) owns the behavior behind that
  Interface.
- Local History Web Mode calls the Local HTTP Adapter through
  [`local-history-client.ts`](../../apps/web/src/features/local-history/local-history-client.ts).
  The client imports only the public browser-safe wire schemas and DTOs from
  `@silksong-git/repo-session/http-wire`; it does not call History internals or read
  Git, SQLite, watcher state, or the local filesystem directly.

The Web client validates every JSON response with the public runtime schemas.
Its initial authenticated `/api/v1/watcher` request establishes the local
session and seeds the first watcher status. Exact routes, payloads, and
authentication rules belong to the
[Local HTTP API reference](../reference/local-http-api.md), not this document.

## Runtime Composition and Routes

[`main.tsx`](../../apps/web/src/main.tsx) explicitly injects the Browser Runtime
Capabilities into [`App.tsx`](../../apps/web/src/app/App.tsx).
`desktop-main.tsx` currently injects the same Static-only capabilities because
the implemented Desktop shell does not yet own a Repo Session. A later Desktop
workflow can use the existing Desktop Adapter only when it can supply a real
in-memory Repo Session endpoint and token. `App.tsx` composes four
application-wide providers around the router:

- the Toast Store owns transient notifications;
- the Preferences Store owns presentation preferences and may persist them in
  browser storage;
- the Save Store owns the one Save State currently rendered by Progress, Map,
  and Raw Save Data; and
- the Local History Store owns connection and local-session state.

The routes are:

| Hash route          | Availability                         | Responsibility                                    |
| ------------------- | ------------------------------------ | ------------------------------------------------- |
| `/` and `/progress` | Both modes                           | Render semantic progress.                         |
| `/map`              | Both modes                           | Render mapped items on the interactive map.       |
| `/raw-save`         | Both modes                           | Render the current Decoded Save JSON.             |
| `/history`          | Connected Desktop Local History only | Browse Semantic Events or Raw Save Observations.  |
| `/diff`             | Connected Desktop Local History only | Compare two commits semantically or as JSON.      |
| `/watcher`          | Connected Desktop Local History only | Show watcher state and create Manual Checkpoints. |

Local-only routes remain addressable. In Desktop they render a
connection-required state while disconnected; in Browser they render an
explicit unavailable state. The Sidebar exposes them only for a connected
Desktop session. A current-save route with a `commit` query parameter follows
the same rule, so a bookmarked historical selection cannot be mistaken for
Static Web Mode.

## Save State Ownership

The Save Store is the sole owner of displayed Save State. Its source is an
explicit tagged value:

```txt
empty
static
localLatest
localCommit(commit)
```

Displayed Save State contains the Decoded Save, optional Semantic Snapshot,
semantic-item lookup, and the derived normal or permadeath display mode. The
Local History runtime coordinates HTTP reads into this store, but does not
become a second Save State store.

The Local History Store separately owns:

- `disconnected`, `connecting`, `connected`, or connection-error state;
- the in-memory endpoint and bearer-token-backed client for a connected session;
- the latest fetched Save State and Watcher status used for synchronization;
  and
- whether failed automatic requests have left already loaded data stale.

The bearer token is captured by the in-memory client closure. Neither endpoint
nor token is written to browser storage or the URL. Reloading the page loses
the session. Presentation preferences are independent of these credentials
and may remain in `localStorage`.

URL query state owns durable navigation selections rather than Save State
itself. In particular, `commit` fixes the three current-save views to one
canonical historical commit; History search fields and a pending compare
source are also represented in the URL; and Diff uses `from` and `to` refs.
Opaque pagination cursors stay in component runtime state.

## Static Web Mode

Static Web Mode is the only mode offered by the Browser build. A disconnected
Desktop presentation also has an empty Static Web Mode current-save surface.
The user may upload either an Encoded Save (`.dat`) or Decoded Save JSON.
[`load-current-save.ts`](../../apps/web/src/features/current-save/load-current-save.ts)
performs this browser-only pipeline through the public Core Interface:

```txt
uploaded File
  -> decode Encoded Save or parse uploaded JSON
  -> recognize the Decoded Save schema
  -> load built-in Mapping Data
  -> create one Semantic Snapshot
  -> load the Save Store as static
```

The browser then renders Progress, Map, and Raw Save Data from that one state.
It has no Git, SQLite, filesystem-watcher, restore, or local API access.
Unrecognized uploaded schemas currently surface as an invalid/corrupted-file
failure in this UI flow; preserving an Unrecognized Schema Observation is a
History responsibility and therefore does not apply in Static Web Mode.

## Local History Web Mode

The Desktop user enters Local History Web Mode through the Topbar connection
control. Its injected capability supplies the Repo Session endpoint and token;
the presentation never asks the user to type either value. A successful
authenticated `/api/v1/watcher` request creates a local session,
seeds its initial watcher status, and clears any uploaded Static Save before
Local History loads its own state.
The Local History runtime then fetches either:

- `latest`, when the URL has no `commit`; or
- the selected immutable commit, when `commit` is present.

The latest response becomes both the displayed `localLatest` Save State and
the session's latest-known state. A historical response becomes the displayed
`localCommit(commit)` state and does not replace that latest-known state. An
unrecognized observation can still provide Decoded Save JSON while omitting a
Semantic Snapshot, so views must tolerate semantic state being unavailable.

Disconnecting clears the displayed Save State and returns to an empty Static
Web Mode at `/progress`. The application never retains an uploaded Static Save
and a Local History Save State as competing sources.

## Latest and Historical Transitions

While a local session is connected and the page is visible, the runtime polls
Watcher status. It treats `observationRevision` as a change signal, not as an
event log. When the revision changes it fetches the latest Save State:

- without `commit`, the new latest state replaces the displayed Save State;
- with `commit`, only the session's latest-known state changes, and the
  historical display remains fixed.

The historical Topbar banner shows the selected ref, reports when a newer
latest observation is known, and removes `commit` for Back to Latest.
Authentication, protocol, or Local Network Access failures pause automatic
requests; already loaded data remains explicitly stale until reconnection or
disconnect. Other transient failures may continue polling.

## Local History Workflows

History has separate Events and Observations views. An Events request without
submitted search fields calls History; submitted structured or text fields
call Search. The shared presentation does not merge those two HTTP behaviors.
Events are grouped by commit, while Raw Save Observations retain their own
pagination. Commit actions select Progress, seed a two-commit comparison,
download the committed Encoded Save, or open the in-place Restore confirmation.
Restore uses the latest committed observation hash as its normal precondition;
the separate missing-file confirmation is explicit.

Diff stores `from` and `to` refs in the URL. It requests the semantic diff and
both Save States independently so one unavailable semantic result does not
prevent a Decoded Save JSON comparison. The semantic view renders the `to`
Snapshot through the reusable Progress renderer with changed-item emphasis;
it does not mutate the application Save Store.

Watcher presents inactive and transitional states as well as the active
watcher's activity, Capture Policy, last observation, and latest Watcher Error.
Its Manual Checkpoint action is
an authenticated HTTP mutation. The Web application does not watch files or
perform the checkpoint itself.

History, Diff, and Watcher are frontend workflows over the Local HTTP Adapter.
The [Save History Module](save-history-module.md) and
[Repo Session](repo-session.md) retain ownership
of persistence, serialization, watcher scheduling, export bytes, and restore
safety.

## Current Limits

This document describes the implemented Solid runtime. Vite produces a Browser
build with the hosted base path and a separate relative-path Desktop build.
The Tauri shell bundles the latter; it does not load a remote UI. Polling is
the implemented synchronization mechanism; there is no SSE or WebSocket event
stream.

The pre-Solid DOM application and extraction notes are retained only as
[legacy migration context](../legacy/web-before-solid/overview.md). They are
not an alternative description of current Web or semantic behavior.
