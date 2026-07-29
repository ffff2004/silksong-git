# Bootstrap Desktop as a hardened shell around shared Web assets

We decided to bootstrap Desktop as a Tauri v2 application that owns one
programmatically created WebView window and bundles a dedicated relative-path
build of the shared Web source. The hosted Browser build retains its existing
base path and output. Each build has an explicit composition root; the first
Desktop slice injects the existing Static-only Runtime Capabilities because it
cannot yet supply a working Repo Session connection.

The native shell owns the security policy instead of expanding the shared Web
Interface. Production navigation is restricted to the bundled application
origin. New-window requests are always denied; only HTTPS links matching the
current wiki, project repository, or exact Steam Cloud target are opened by a
Rust-side operation after URL parsing and validation. The opener plugin's
automatic JavaScript link handling is disabled.

The application registers single-instance handling before every other plugin
and creates exactly one window labeled `main`. A second process ignores its
arguments and working directory and only attempts to show, unminimize, and
focus that existing window.

The production CSP permits bundled resources, Tauri IPC origins, and future
IPv4-loopback Repo Session connections. The sole window capability grants no
guest-callable native permissions, and the global Tauri object is disabled.
The WebView therefore has no filesystem, shell, process, generic opener, or
arbitrary HTTP authority. Later Desktop workflow slices must add intent-level
Interfaces deliberately rather than weakening this baseline.
