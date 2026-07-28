# Disposable Tauri Linux prototype

> **THROWAWAY PROTOTYPE for issue #42.** This is evidence for the future
> Desktop implementation. It is not the production `apps/desktop` authority,
> product UI, or final sidecar protocol.

This application packages the already-proven issue #22 Node SEA as a Tauri v2
target-specific external binary and packages its private Git runtime, notices,
and one save fixture as resources. The Rust shell exposes only intent-level
prototype commands to its bundled WebView.

Run the complete real-AppImage and clean-container verification from the
repository root:

```sh
pnpm prototype:tauri-linux
```

The generated build staging, bundle, screenshots, and machine evidence live
under ignored `dist/` and `src-tauri/target/` directories.
