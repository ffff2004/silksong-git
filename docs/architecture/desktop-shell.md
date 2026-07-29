# Desktop Shell Architecture

The Desktop application is a Tauri v2 delivery Adapter around the shared Solid
presentation. It currently supports Static Save inspection only. It does not
own Repo Session, History, Git, SQLite, filesystem watching, native file
selection, or repository layout.

## Composition and Build

[`apps/desktop`](../../apps/desktop) owns native lifecycle and packaging.
[`desktop-main.tsx`](../../apps/web/src/desktop-main.tsx) is the Desktop Web
composition root and explicitly injects the same Static-only
`browserRuntimeCapabilities` as the Browser entry. Both entry points reuse
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

The unique `main` capability has an empty permission list and the global Tauri
object is disabled. The CSP allows bundled application resources, the Tauri IPC
origin, and future IPv4-loopback connections. It grants no generic filesystem,
shell, process, arbitrary HTTP, or native command Interface.

This boundary implements
[ADR-0021](../adr/0021-hardened-desktop-shell.md). The shared presentation and
Runtime Capabilities seam remain owned by the
[Web architecture](web.md).

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
