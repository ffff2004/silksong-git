# Desktop Shell Architecture

The Desktop application is a Tauri v2 delivery Adapter around the shared Solid
presentation. It supports Static Save inspection and one temporary external
Save History Repository session. It does not own Repo Session, History, Git,
SQLite, watcher scheduling, or repository layout.

The Rust shell owns native directory selection, canonicalization, and the
private [`apps/desktop-sidecar`](../../apps/desktop-sidecar) process lifecycle.
Debug builds run Node with the fixed
`apps/desktop-sidecar/dist/main.js` entry, which must exist before Desktop
starts. Non-debug builds resolve the fixed `silksong-git-desktop-sidecar`
executable beneath the application resource directory and report Local History
as unavailable when it is absent. A selected repository path is sent only in
JSONL `repository.inspect` and `session.open` messages, never as a spawn
argument.

## Composition and Build

[`apps/desktop`](../../apps/desktop) owns native lifecycle and packaging.
[`desktop-main.tsx`](../../apps/web/src/desktop-main.tsx) is the Desktop Web
composition root and explicitly injects Desktop Runtime Capabilities. The
Browser entry injects Static-only browser capabilities. Both entry points reuse
`App`, the Save Store, and the Progress, Map, and Raw Save feature Modules.

Vite creates two outputs from the one Web source:

```txt
build:browser -> apps/web/dist
build:desktop -> apps/web/dist-desktop
```

The shared HTML names its composition-root script and build identity with
explicit placeholders. The Vite configuration requires each placeholder
exactly once, selects `main.tsx` plus `browser` for the Browser build, and
selects `desktop-main.tsx` plus `desktop` for the Desktop build. The Desktop
asset audit verifies the resulting identity and rejects unresolved placeholders
or remote runtime assets.

The Browser build keeps its hosted base path. The Desktop build uses relative
asset paths, and Tauri embeds that output as application assets. Production
does not load scripts, styles, fonts, workers, or UI documents from a remote
origin.

## Native Lifecycle

The Rust shell registers the single-instance plugin first. Tauri configuration
creates no declarative windows; setup constructs the only window with label
`main` so every WebView receives the same navigation and popup policy. A
second invocation discards its arguments and working directory and makes a
best-effort attempt to show, unminimize, and focus the existing main window.

## WebView Security Boundary

The main window permits navigation only within the bundled application origin.
Development additionally permits the fixed `http://127.0.0.1:1420` Vite
origin. Every popup request is denied. When a popup URL matches the Rust URL
allowlist, Rust sends it to the system browser before returning the denial;
invalid URLs and opener failures never create another WebView.

The allowlist admits only HTTPS without credentials or a non-default port and
then restricts targets to:

- `hollowknight.wiki`;
- the `github.com/ffff2004/silksong-git` repository path; and
- `/account/remotestorageapp/?appid=1030300` on
  `store.steampowered.com`.

The opener plugin is registered only for its Rust Interface. Its automatic
JavaScript link handling is disabled, and the WebView receives no opener
permission.

The global Tauri object is disabled. The unique `main` capability allows only
five application intent commands: open an external repository, explicitly
reopen an invalidated in-memory selection, obtain the current Repo Session
connection, and start or stop watching for that current session. It grants no
generic filesystem, shell, process, arbitrary HTTP, or native command
Interface. The CSP allows bundled application resources, the Tauri IPC origin,
and IPv4-loopback connections.

This boundary implements
[ADR-0021](../adr/0021-hardened-desktop-shell.md). The shared presentation and
Runtime Capabilities seam remain owned by the
[Web architecture](web.md).

## Repo Session Process Boundary

The private Desktop sidecar accepts versioned JSONL lifecycle commands on stdin
and reserves stdout for responses and safe lifecycle events. It calls only the
public `@silksong-git/repo-session` Interface. One process opens at most one
Repo Session; History reads and mutations remain behind that session's
authenticated loopback HTTP endpoints instead of becoming process RPC.

Opening is ordered deliberately: Rust waits for a native directory selection,
canonicalizes it, starts a candidate sidecar, and sends `repository.inspect`.
Only a `ready` result may replace the current session; Rust gracefully shuts
down the prior sidecar and then sends `session.open`, which re-inspects through
the Repo Session Interface. Invalid, migration-required, rebuild-required, and
newer-incompatible selections return structured actionable states without
opening a session. The temporary external path is neither copied, persisted,
registered, nor reopened after exit.

The session endpoint and bearer token are held in the Rust runtime state. The
WebView can obtain them only through the one narrow connection command, where
the Web Runtime Capability captures them in its in-memory authenticated Local
HTTP client closure. They are never returned by the picker or watcher commands,
put in a URL, or persisted. Disconnecting the WebView drops only that closure;
it can request the current connection again without reopening a directory.
Start and stop watcher commands carry no repository path and act only on the
current sidecar session. A watch-lock conflict leaves that reader session and
its HTTP browsing capability intact. Session replacement and App exit request
sidecar shutdown and wait for its graceful acknowledgment.

`DesktopWorkflow` is the sole Desktop session/lifecycle owner. It models Empty,
Active, Transitioning, and Invalidated states. Candidate inspection completes
before a session transition, so a cancelled or incompatible selection preserves
an Active reader. A normal replacement or exit is rejected while a Manual
Checkpoint or In-Place Restore is active; once accepted it delegates admission
closure, watcher scheduling, and drain to Repo Session rather than duplicating
that work. Other normal operations during a transition return busy. Native exit
asks for confirmation if this workflow is watching and otherwise shuts down
deterministically.

The successful sidecar open response discloses the in-memory HTTP credential to
Rust exactly once. Watcher events are projected without paths, raw exceptions,
credentials, commit details, or Semantic Events. Graceful process shutdown is
acknowledged only after Repo Session has drained admitted HTTP and watcher work.
The exact wire and exit contract belongs to the
[Desktop Sidecar Process Protocol](../reference/desktop-sidecar-protocol.md)
and follows
[ADR-0022](../adr/0022-use-a-private-versioned-desktop-sidecar.md).

The private `SidecarSupervisor` is the only stdout reader. It correlates JSONL
responses by request ID, consumes safe lifecycle events, drains stderr, and
classifies child exit. EOF, a process exit, protocol failure, or session-fatal
event invalidates the Desktop connection and retains only the in-memory selected
path as an explicit reopen target. Reopen starts a fresh reader with watching
inactive; it never automatically restarts a watcher or mutation.

## Validation

The repository-level `pnpm lint` and `pnpm verify` commands include the Desktop
Rust lint, tests, and production build. After `pnpm build-desktop`, Linux
maintainers can run the system-level smoke locally:

```sh
dbus-run-session -- xvfb-run -a pnpm --filter @silksong-git/desktop smoke:webkit
```

The smoke has been tested with `tauri-driver` 2.0.6 and requires
`WebKitWebDriver`. These are external test tools; neither is packaged into the
application or granted production authority. The smoke exercises Encoded and
Decoded Save uploads, bundled Monaco rendering under the production CSP,
allowed native external opening, denied popups, and denied remote navigation in
the real Desktop WebView.

The current GitHub Actions workflow predates the Desktop application and is not
the authority for its verification coverage.
