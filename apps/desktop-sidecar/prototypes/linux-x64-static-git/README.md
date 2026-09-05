# Linux x64 SEA + static-git sidecar prototype

> **THROWAWAY PROTOTYPE.** This directory is evidence for the Linux bundled
> runtime decision. It is not production Desktop packaging code.

This prototype answers one question:

> Can the current `apps/desktop-sidecar` entrypoint be injected into Node.js
> SEA and run with the `darkvertex/static-git` 2.55.0 Linux x64 Git binary on a
> clean Linux image with no system Node.js or Git?

Run the complete build and clean-container verification from the repository
root:

```sh
pnpm prototype:linux-sidecar-static-git
```

The build produces the same target-triple name that Tauri external binaries
use and the strict resource shape consumed by the current BundledRuntime
resolver:

```text
dist/artifact/runtime/manifest.json
dist/artifact/runtime/bin/silksong-git-sidecar-x86_64-unknown-linux-gnu
dist/artifact/runtime/bin/git
dist/artifact/runtime/notices/*
```

The verification runs the real sidecar process over its versioned JSONL
protocol, then uses a test-only static curl helper inside the same
`--network=none` container to exercise the authenticated Repo Session HTTP
API. Generated artifacts and `dist/evidence.json` are intentionally ignored.

Pinned inputs are recorded in `build.ts`, `prepare-static-git.ts`, and the
generated evidence. This prototype uses the Node 24 SEA preparation-blob
workflow plus `postject`, because the production runtime policy currently
requires Node 24; it does not require the newer Node 25 `--build-sea` flag.
