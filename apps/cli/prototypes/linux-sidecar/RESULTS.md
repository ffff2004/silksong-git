# Linux sidecar spike results

## Verdict

Issue #22's distribution question is answered **yes for
`x86_64-unknown-linux-gnu`**:

- Bundle the machine Adapter and public History dependencies to one CommonJS
  entry.
- Inject that entry into the pinned official Node.js 24 LTS executable with
  Node SEA.
- Ship a pinned private upstream Git executable as a Tauri resource.
- Let the Rust shell resolve that resource and pass its absolute private `bin`
  directory to the sidecar. The sidecar replaces its process `PATH` with only
  that directory; it does not depend on the user's `PATH`.
- Stage the SEA as
  `silksong-git-sidecar-x86_64-unknown-linux-gnu`, matching Tauri's
  `externalBin` filename contract.

This preserves Node's native `node:sqlite`, subprocess, HTTP, stream, and
signal behavior. It does not require a runtime or persistence rewrite.

The spike's static Git build is sufficient to prove the distribution shape,
but is not itself approved for production redistribution. Its two upstream
locale-test failures and full static dependency/source inventory must be
resolved by the Linux packaging ticket. The product decision is “Node SEA plus
a private upstream Git resource,” not “copy this exact prototype binary
unchanged.”

## Reproduction

From the repository root:

```sh
pnpm prototype:linux-sidecar
```

The command pins:

- Node.js 24.18.0 official Linux x64 archive, SHA-256
  `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`;
- Nixpkgs revision
  `61b7c44c4073f0b827768aff0049561b5110ea5a`;
- Git 2.54.0 source, SHA-256
  `f689162364c10de79ef89aa8dbf48731eb057e34edbbd20aca510ce0154681a3`;
  and
- Debian bookworm-slim clean image digest
  `sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e`.

It builds the Git resource with Nix, bundles the current workspace source,
generates and injects the SEA blob, verifies all three expected notice files,
and then uses Podman as a Tauri-like parent process. The parent passes the
absolute `/artifact/resources/bin` directory just as Rust will pass its
resolved Tauri resource directory. The clean container has no system `node` or
`git` and has networking disabled.

## Measured clean-environment evidence

Representative run on 2026-07-27, Arch Linux x86-64 host, Podman 6.0.1:

| Measurement                                    | Result              |
| ---------------------------------------------- | ------------------- |
| First spawn to `ready` including Podman start  | 378.67 ms           |
| Second spawn to `ready` including Podman start | 345.73 ms           |
| Repository initialization                      | 12.73 ms            |
| First Raw Save Observation                     | 69.13 ms            |
| Raw observation query                          | 4.70 ms             |
| Fresh-process reopen query                     | 3.29 ms             |
| Byte-exact restore                             | 14.56 ms            |
| SEA executable                                 | 125,308,096 bytes   |
| Static Git resource                            | 4,978,304 bytes     |
| Notices and other resources                    | 178,916 bytes       |
| Uncompressed artifact tree                     | 130,465,316 bytes   |
| Generic `.tar.xz` of artifact tree             | 31,454,236 bytes    |
| Encoded Save SHA-256 before/after restore      | `db1adc07…596e3b58` |

Timings are feasibility measurements, not performance budgets. The generated
`dist/evidence.json` contains the complete result from the latest run,
including artifact hashes and the observed commit ref.

## Behaviors proved

The clean workflow:

1. launches only the target-triple SEA and its private Git resource;
2. initializes a real Save History Repository through `initSaveHistory`;
3. commits a real Raw Save Observation through `observeSave`;
4. queries it through `queryRawObservations`;
5. exits only after an active operation completes when `shutdown` has already
   been requested;
6. launches a new sidecar process over the existing repository;
7. queries and restores through public History Interfaces;
8. verifies the restored Encoded Save byte-for-byte; and
9. kills a third sidecar and observes non-zero exit 137 without a false
   `stopped` message.

Every stdout line parses as a version-1 JSON message. Human logs are observed
only on stderr. The parent accepts the prototype-only `prototypePhase` event
without treating it as a response, demonstrating that an unknown event need
not corrupt framing.

## Runtime resources and ABI

The SEA remains a normal official Node GNU/Linux executable rather than a
fully static Linux program. Its highest referenced symbol is `GLIBC_2.28`; it
uses the system GNU loader, glibc, libstdc++, libgcc, libm, libdl, and pthread
ABI. That is an operating-system compatibility floor, not a requirement to
install Node.

The Git resource is a musl-static ELF with no dynamic `NEEDED` entries. The
exercised init/add/commit/rev-list/show behavior uses the one copied
`resources/bin/git`; no `libexec` tree or Git templates were required by this
workflow. Production should still configure and resolve a Tauri resource
directory explicitly rather than assume adjacency or the current working
directory.

Only Linux x86-64 is proved. The build rejects other hosts instead of
mislabeling a binary. Linux ARM64 needs its own official Node archive,
target-triple file, native/static Git build, clean runner, and complete smoke
evidence. Windows and macOS remain later delivery targets.

## CI implications

A target job needs pnpm/Node for source tooling, Nix with flakes to build the
pinned Git derivation, Podman for clean smoke verification, and standard ELF
inspection tools. A cold Nix build observed about 185 MiB of downloads and
585 MiB unpacked build inputs; caches should retain the Node archive, Nix
closure, container image, and pnpm store.

CI must retain the input revisions and checksums, build flags, target triple,
artifact hashes/sizes, ELF inventory, clean-workflow result, and complete
license/source inventory. The generated binary belongs in Tauri's build
staging directory and must not become source authority.

## Negative evidence and rejected alternatives

- Bun compile is rejected for the unchanged runtime because Bun does not
  implement `node:sqlite`.
- `pkg` is rejected because it is deprecated and archived.
- Deno compile remains the fallback if SEA later fails an accepted size,
  reproducibility, or platform criterion; changing runtimes without such a
  failure would add compatibility risk without solving a demonstrated
  problem.
- isomorphic-git, libgit2, and Rust Git implementations are rejected for this
  effort because they replace the canonical Git Adapter rather than package
  it.
- Copying the host `/usr/bin/git` is rejected because it does not carry a
  portable runtime/resource closure.
- The initial Alpine build-container experiment was abandoned after its
  package mirror stalled during toolchain installation. Pinning the Nix
  derivation removed that mirror dependency from the selected workflow.
- Unmodified Nixpkgs static Git ran 28,878 upstream tests but failed two
  `t3434-rebase-i18n.sh` cases. The spike records the failure, disables the
  install-check only to obtain an artifact, and then proves the complete
  project command surface. Production must resolve or explicitly accept the
  narrowed locale behavior; it must not silently claim the upstream suite
  passed.
- `postject` prints ELF note-section lookup warnings while successfully
  injecting the SEA. The final executable starts and passes ELF/protocol
  smoke tests, but CI should retain those warnings and revalidate on every
  Node/postject upgrade.

Primary-source rationale and complete alternative analysis are in
[RESEARCH.md](RESEARCH.md). Redistribution obligations and the reason this
prototype artifact is not directly releasable are in [NOTICES.md](NOTICES.md).
