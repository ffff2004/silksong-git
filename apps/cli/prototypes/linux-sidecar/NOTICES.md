# Prototype redistribution inventory

This inventory is engineering evidence for issue #22, not legal advice and not
a release-ready notice bundle.

## Files placed in the prototype artifact

- The sidecar is the official Node.js 24.18.0
  `node-v24.18.0-linux-x64` executable with the bundled application injected as
  a Single Executable Application. Node.js is MIT licensed and its release
  `LICENSE` contains the notices for dependencies embedded by Node. The build
  copies that exact file to `notices/NODE-LICENSE`.
- `resources/bin/git` is Git 2.54.0 built by the pinned Nixpkgs revision
  `61b7c44c4073f0b827768aff0049561b5110ea5a` as
  `pkgsStatic.gitMinimal` for x86-64 musl. Git is GPL-2.0. The build copies
  upstream Git's exact `COPYING` to `notices/GIT-COPYING`.

The Git source archive is
`https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.54.0.tar.xz`,
SHA-256
`f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3`.
A production distribution must accompany the GPL binary with the applicable
corresponding-source mechanism, build recipe, Nixpkgs patches, and local
changes.

## Static Git dependency consequence

The Nixpkgs Git executable is statically linked. Its build inputs include musl,
zlib-ng, curl, OpenSSL, expat, libiconv, and shell support in addition to Git.
A production notice/source bundle must be generated from the exact pinned
derivation and cover every linked component; copying only Git's GPL text is
insufficient. The prototype deliberately retains this requirement as a
release-gating task instead of claiming that `gitMinimal` means “Git only.”

The unmodified Nixpkgs install check ran 28,878 upstream Git tests. Two
`t3434-rebase-i18n.sh` cases failed in the musl-static configuration; all other
executed tests passed, while tests with unavailable optional dependencies were
skipped. The reproducible prototype disables that install-check phase only
after recording the failure, then verifies the complete Silksong Git command
surface in a clean container. This candidate must not be promoted to a
production binary until the locale failures are understood or the production
build is narrowed and its expected test matrix is accepted.

## Build-only tools

`postject`, tsup/esbuild, pnpm, Nix, Podman, and the compiler toolchain are
build/test tools and are not copied into the prototype artifact. Their exact
versions and licenses still belong in CI provenance. Tauri is not built by this
spike; the produced target-triple sidecar path is the input later consumed by
Tauri.
