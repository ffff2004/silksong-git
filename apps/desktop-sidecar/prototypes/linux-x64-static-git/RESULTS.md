# Prototype result: Linux x64 bundled runtime sidecar

> **THROWAWAY PROTOTYPE.** This records one successful build and verification
> run. It is not a production release approval.

## Verdict

The expected bundled runtime sidecar shape is feasible for
`x86_64-unknown-linux-gnu`:

- Node.js 24.18.0 SEA embeds the current desktop sidecar JavaScript entrypoint.
- `darkvertex/static-git` 2.55.0 supplies a standalone `git` executable.
- The resulting `runtime/` directory matches the strict bundled manifest shape
  consumed by the current Tauri runtime resolver.
- The sidecar runs in a pinned clean Debian container with `PATH` restricted to
  `runtime/bin`, no system Node.js or Git, and `--network=none`.
- The real sidecar JSONL protocol and authenticated Repo Session HTTP boundary
  completed an initialize → observe → query → export → mutate → restore →
  graceful shutdown → reopen workflow. Exported and restored save bytes were
  byte-for-byte exact.

The production AppImage/Tauri integration remains outside this prototype.

## Verification run

Command:

```sh
pnpm prototype:linux-sidecar-static-git
```

Run timestamp: `2026-09-05T02:40:10.771Z`

| Check                  | Result                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Target                 | `x86_64-unknown-linux-gnu`                                                                         |
| Sidecar protocol       | version `11`                                                                                       |
| Clean image            | `docker.io/library/debian@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e` |
| System Node.js / Git   | absent / absent                                                                                    |
| Runtime network        | disabled                                                                                           |
| Graceful shutdown      | exit `0`                                                                                           |
| Forced termination     | exit `137` detected without false graceful result                                                  |
| First / second startup | `383.15 ms` / `367.89 ms`                                                                          |
| Raw observations       | `1`                                                                                                |
| Export / restore       | byte exact / byte exact                                                                            |
| Runtime artifact       | `133205812` bytes                                                                                  |

## Artifact fingerprints

Generated under `dist/artifact/` by the command above:

| File                                                        |        Size | SHA-256                                                            |
| ----------------------------------------------------------- | ----------: | ------------------------------------------------------------------ |
| `runtime/bin/silksong-git-sidecar-x86_64-unknown-linux-gnu` | `125635776` | `0f711855559bf182de64cc022241df453f4a3c6f3c28875368990f4c7d5c5ec3` |
| `runtime/bin/git`                                           |   `7357160` | `1aa5ab3332fb8c6a38b4b0b31de9a5288cd0583ede84dabab48418edf2b8f676` |

The SEA sidecar is an x86-64 dynamically linked ELF using the glibc loader.
The static Git binary is x86-64 `static-pie`; `readelf -d` reports no
`NEEDED` entries. Both binaries retain debug information because this is a
prototype build.

## Pinned inputs

- Node.js archive: `node-v24.18.0-linux-x64.tar.xz`, SHA-256
  `55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742`.
- static-git release asset: `git-binaries.linux-64bit.tar.gz`, SHA-256
  `8c34e40809b9ec271db4b344953f73c9c3a2c3de022be308d567adeee6eb770e`.
- Upstream Git 2.55.0 source archive, used for `COPYING`, SHA-256
  `457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357`.
- static-git project `LICENSE`, SHA-256
  `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`.

The generated artifact includes `NODE-LICENSE`, `STATIC-GIT-LICENSE`,
`GIT-COPYING`, and `PROTOTYPE-NOTICES.md`. The binary-only static-git release
still needs a production corresponding-source and dependency inventory for
the exact static build.

## Follow-up risks

- `postject` emits ELF `.note` section-offset warnings while injecting the SEA
  blob, but reports `Injection done!` and the clean-container smoke test passes.
  Any Node.js or postject upgrade must rerun this qualification.
- The Node SEA executable is dynamically linked, so supported Linux/glibc
  baseline must be chosen and verified before release.
- This prototype uses a test-only static curl binary to call the sidecar's
  loopback HTTP API inside the network-disabled container. curl is not copied
  into the runtime artifact.
- Packaging, Tauri resource staging, AppImage assembly, signing, stripping,
  reproducible-build policy, and release notice/source publication remain for
  the downstream packaging work.
