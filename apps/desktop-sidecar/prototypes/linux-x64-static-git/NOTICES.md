# Prototype redistribution notes

This file is copied into the generated artifact as engineering evidence. It
is not legal advice or a release-ready notice bundle.

The sidecar is built from the official Node.js 24.18.0 Linux x64 archive and
contains a bundled JavaScript entry created with Node Single Executable
Applications. The artifact includes Node's `LICENSE` as `NODE-LICENSE`.

The private Git resource is the `git` executable from
`darkvertex/static-git` release `2.55.0`, asset
`git-binaries.linux-64bit.tar.gz`. The artifact includes that project's GPLv3
`LICENSE` as `STATIC-GIT-LICENSE` and the upstream Git 2.55.0 `COPYING` file as
`GIT-COPYING`. The release is described as statically compiled Git from the
upstream Git 2.55.0 tag; the asset contains binaries only, so a production
distribution still needs a complete corresponding-source and dependency
inventory for the exact static build.

The test-only static curl helper is not copied into the runtime artifact.
`tsup`, `postject`, pnpm, Nix, Podman, and the host build tools are also
build/verification inputs only.
