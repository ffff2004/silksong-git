# Issue #22 evidence: self-contained Linux sidecar distribution

## Question and project constraints

[Issue #22](https://github.com/ffff2004/silksong-git/issues/22) asks whether
the TypeScript Repo Session and History runtime, including Git, can be shipped
as a target-specific Tauri sidecar without system Node.js or Git. This note
compares the viable 2026 packaging choices; it does not record implementation
progress or claim measurements that the prototype has not produced.

The [desktop Parent Spec](https://github.com/ffff2004/silksong-git/issues/20)
and its
[architecture refinement](https://github.com/ffff2004/silksong-git/issues/20#issuecomment-5084167724)
fix several inputs to the decision:

- The private machine-process Adapter remains TypeScript and calls public Repo
  Session and History Interfaces. Rust owns the sidecar lifecycle but must not
  reimplement Git, SQLite, repository validation, restore, or repository
  layout.
- Git remains the canonical raw-history and restore store. SQLite remains the
  rebuildable Semantic Read Model.
- The packaged process must preserve strict versioned JSON/JSONL on stdout,
  logs on stderr, unexpected-exit detection, and graceful shutdown.
- Linux is first, but the selected mechanism must not make later Windows and
  macOS artifacts structurally impossible.

The current History implementation is a particularly important constraint. At
the investigated revision, its
[Git Adapter](https://github.com/ffff2004/silksong-git/blob/57fc9b6a8c5b559dbe76dc0b71c9cb02d060c8fe/packages/history/src/git-store.ts)
uses `node:child_process` to execute `git`, while its
[read model](https://github.com/ffff2004/silksong-git/blob/57fc9b6a8c5b559dbe76dc0b71c9cb02d060c8fe/packages/history/src/read-model.ts)
uses Node's built-in `node:sqlite` `DatabaseSync`; it does not currently use a
native npm SQLite addon. Node 24 documents `node:sqlite` as a release-candidate
API and `DatabaseSync` as synchronous
([Node 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)).
Packaging the existing runtime is therefore lower risk than changing its
runtime and persistence Adapter at the same time.

## Finding

The clearest first feasibility path is:

1. bundle the sidecar and its workspace dependencies into one CommonJS entry;
2. inject that entry into the pinned official Node 24 LTS executable using
   Node's Single Executable Application (SEA) process;
3. build a minimal, relocatable Git distribution from a pinned upstream Git
   release and include it, its required runtime files, and notices as Tauri
   resources;
4. have the Rust shell supply the absolute private Git `bin` directory and let
   the sidecar replace its process `PATH` with only that directory before
   calling History, never resolving `git` from the user's `PATH`; and
5. stage the SEA under Tauri's target-triple filename before `tauri build`.

This is provisional, not yet the final issue #22 decision. Node SEA is still
documented as **active development**, and Node 24's SEA accepts one embedded
CommonJS script. The prototype must prove that the bundled workspace entry,
`node:sqlite`, Hono Node server Adapter, machine protocol, shutdown behavior,
and bundled Git all work together
([Node 24 SEA documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/single-executable-applications.html)).

## TypeScript runtime comparison

| Approach                  | Self-contained and target support                                                                                                                                                                                                                                                   | Fit with the current runtime                                                                                                                                                                                                                                                                                                                                       | Distribution and CI implications                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Issue #22 assessment                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node 24 LTS SEA**       | Produces an executable for a machine without Node. The SEA blob must be made by the same Node version as the executable receiving it. Node 24 uses a CommonJS entry and the documented `postject` flow. Cross-platform code cache and snapshots must be disabled.                   | Best semantic fit: the packaged runtime is Node, and `node:sqlite`, `node:child_process`, the Hono Node Adapter, signal handling, and Node stream behavior remain on their native runtime. The application still needs a deterministic bundling step because SEA embeds one script and its injected `require()` resolves only built-ins unless the app is bundled. | Pin the exact Node 24 release, official binary checksum, bundler, and `postject`. Produce one artifact per OS/architecture. SEA remains Stability 1.1, so every Node update needs packaged smoke tests.                                                                                                                                                                                                                                                                                                     | **Recommended first prototype and likely production choice if clean-environment evidence passes.** It makes the fewest runtime changes and is supportable on an LTS line.                          |
| **Deno `compile`**        | Produces a self-contained `denort` executable, embeds files with `--include`, and cross-compiles to Linux x86_64/aarch64 GNU targets, Windows x86_64, and macOS x86_64/aarch64. Foreign-target runtimes are downloaded and cached.                                                  | Plausible: Deno added `node:sqlite` in 2.2 and documents `node:child_process` as supported. This is nevertheless a Node compatibility layer, not the runtime against which the repository is currently verified. The complete Hono, workspace-resolution, `createRequire`, subprocess, signal, and SQLite behavior still needs testing.                            | Deno can compile npm dependencies and now embeds the resolved `node_modules` tree by default. Its optional `--bundle` is explicitly experimental and drops non-statically traceable dynamic imports; compile without it first or explicitly include dynamic dependencies. Permissions must be fixed at compile time. Only GNU Linux targets are listed; the official docs do not state a durable minimum glibc contract for the current `denort`, so measure the actual ELF and oldest supported container. | **Viable fallback.** Packaging is simpler and cross-compilation is stronger than Node 24 SEA, but compatibility risk is greater and must be justified by measured benefit.                         |
| **Bun `build --compile`** | Produces one executable containing the Bun runtime and supports Linux x64/aarch64 for glibc or musl, Windows x64/aarch64, and macOS x64/aarch64. Linux x64 has baseline and modern CPU variants; Bun warns that the modern build may fail with `Illegal instruction` on older CPUs. | Blocked for an unchanged runtime: Bun's current Node-compatibility reference explicitly says `node:sqlite` is not implemented. Bun offers `bun:sqlite` and can embed N-API addons, but either choice changes the current SQLite Adapter and its behavior.                                                                                                          | Cross-compilation and asset embedding are convenient. A production use would need a History-internal SQLite Adapter or a pinned native addon, a second-runtime behavior matrix, and license handling for Bun's statically linked LGPL-2 WebKit/JavaScriptCore components.                                                                                                                                                                                                                                   | **Not the first path.** Reconsider only if a runtime-neutral SQLite seam is accepted for architectural reasons independent of packaging, and then run all public History behavior tests under Bun. |
| **`pkg`**                 | Historically made Node executables.                                                                                                                                                                                                                                                 | Its virtual-filesystem conventions would add another compatibility surface.                                                                                                                                                                                                                                                                                        | The owner deprecated `pkg` at 5.8.1 and archived the repository in January 2024, pointing users toward Node SEA.                                                                                                                                                                                                                                                                                                                                                                                            | **Reject.** An archived packaging foundation is not appropriate for a new production distribution.                                                                                                 |

Primary runtime sources:

- [Node 24 SEA](https://nodejs.org/download/release/latest-v24.x/docs/api/single-executable-applications.html)
  documents the one-script CommonJS restriction, version matching, assets,
  `postject`, cross-platform cache restrictions, and limited `require()`.
- [Node 24 platform support](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
  gives Tier 1 x64 and arm64 Linux requirements of kernel 4.18 and glibc 2.28;
  official Linux binaries are built on RHEL 8.
- [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/)
  documents the targets, `denort` download, asset inclusion, npm dependency
  handling, experimental bundling, and self-extracting mode.
- [Deno `node:sqlite`](https://docs.deno.com/api/node/sqlite/) and
  [Node compatibility](https://docs.deno.com/runtime/fundamentals/node/)
  establish that Deno implements the required built-in through a compatibility
  layer.
- [Bun standalone executables](https://bun.com/docs/bundler/executables) and
  [Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat)
  establish its targets and the current `node:sqlite` gap.
- [`pkg` status](https://github.com/vercel/pkg) records deprecation, final
  release, and repository archival.

### Node SEA packaging consequences

For Node 24, a reproducible build should:

- pin one Node 24 patch release and verify the official archive checksum;
- produce one bundled CommonJS file, keeping `node:*` built-ins external so the
  SEA loads Node's own modules;
- set `useSnapshot: false` initially; set `useCodeCache: false` for any
  cross-built artifact and initially for native builds as well, because Node
  documents that dynamic `import()` does not work with code cache;
- set `execArgvExtension: "none"` so ambient `NODE_OPTIONS` cannot change the
  packaged process contract;
- generate the preparation blob with the exact Node binary that will receive
  it, copy that binary, and inject with the Node-maintained
  [`postject`](https://github.com/nodejs/postject) tool; and
- hash the final SEA, report `process.version` through the diagnostic protocol,
  and retain the exact Node license file alongside product notices.

The current `createRequire(import.meta.url)("node:sqlite")` pattern is a
specific bundling risk: Node SEA's injected `require()` can load built-ins, but
the CommonJS bundler's treatment of `import.meta.url` must be verified. A
static built-in import or a small runtime loader change may be required. That
would remain inside History's SQLite implementation boundary, but it must be
proved by public History behavior tests rather than assumed.

Node 25.5 introduced a direct `--build-sea` command, but in July 2026 the
project should prefer the even-numbered Node 24 LTS line rather than base a new
distribution on an odd, non-LTS line. The Node release policy makes even
versions the LTS lines
([Node release policy](https://github.com/nodejs/Release)). A future Node 26
LTS migration can reassess direct SEA construction after that line enters LTS;
it is not evidence for avoiding Node 24's current documented injection step.

## Providing Git without system Git

### Preferred path: an upstream Git executable and private runtime resources

The current History Git Adapter already expresses the necessary operations
through the canonical CLI: initialize, stage, commit, resolve/rev-list, show
commit metadata, and read blobs. Bundling Git therefore preserves both the
public History Interface and its existing behavioral seam.

Do not equate “Git is one command” with “copy `/usr/bin/git`.” Upstream Git's
installation documentation says that installed paths are encoded by default,
that Git requires zlib, and that optional features introduce Perl, shell,
libcurl, expat, Tcl/Tk, gettext, Python, SSH, and other dependencies
([upstream `INSTALL`](https://github.com/git/git/blob/master/INSTALL)).
Git also has an exec path for core programs, controlled by `GIT_EXEC_PATH`
([`git` documentation](https://git-scm.com/docs/git)), and `git init` selects a
template directory from `--template`, `GIT_TEMPLATE_DIR`, configuration, or
its compiled default
([`git-init` documentation](https://git-scm.com/docs/git-init)).

The appropriate artifact is therefore a deliberately built and tested private
Git distribution:

- Pin an upstream Git release and build from its signed/released source, not
  from the host distribution's `/usr/bin/git`.
- Enable `RUNTIME_PREFIX`, which upstream documents as resolving ancillary
  tools and support files relative to the runtime binary, instead of encoding
  an immovable prefix
  ([upstream `Makefile`](https://github.com/git/git/blob/master/Makefile)).
- Remove capabilities issue #22 does not use with the upstream build switches,
  initially `NO_CURL`, `NO_EXPAT`, `NO_PERL`, `NO_PYTHON`, `NO_TCLTK`, and
  `NO_GETTEXT`. Disable documentation. Keep collision-detecting SHA-1 behavior;
  do not trade repository integrity for size.
- Stage an installation tree, not an ad hoc binary: at least `bin/git`,
  whichever `libexec/git-core` programs the installed build produces, and the
  template directory unless the prototype proves a deliberately empty,
  explicit template is sufficient. Preserve symlinks or install copies
  deterministically.
- Prefer static linking of the mandatory zlib and other selected non-libc
  dependencies, or bundle a private library directory with a controlled ELF
  runpath. Do not rely on the user's zlib, curl, OpenSSL, gettext, or Perl.
  Fully static glibc has its own runtime and licensing complications; a
  musl-built static Git is worth measuring because these workflows are local
  and do not need HTTP, SSH, or name-service lookups.
- Resolve the resource directory in Rust and pass the absolute private Git
  `bin` directory to the sidecar. Until History accepts an executable path,
  the sidecar replaces its process `PATH` with only that directory before any
  History call; it does not prepend to or inherit ambient `PATH`. A future
  History executable-path seam may remove this process Adapter without
  changing the resource layout. Set `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR`
  explicitly if the staged tree requires them.
- Preserve the existing environment hardening (`GIT_CONFIG_NOSYSTEM`,
  `GIT_ATTR_NOSYSTEM`, no terminal prompt, C locale, disabled hooks and
  signing). Add `HOME`/global-config isolation in the clean test if the
  packaged workflow must be independent of user Git configuration.

The current command set appears to use Git built-ins, so a single Git
executable plus templates and ELF dependencies may prove sufficient. That is
an optimization hypothesis, not a packaging assumption. Run the entire
init-observe-query-restore workflow with the candidate tree and inspect every
spawn with a scrubbed `PATH`.

#### Is a minimal fully static Git feasible?

It is a credible prototype candidate, but not yet an evidence-backed
distribution claim. The upstream build system provides the feature-removal and
runtime-prefix controls needed to make the exercised local-only command surface
small, but upstream does not publish a supported universal “static Git”
artifact or a guaranteed one-file runtime closure. A musl-linked build with
network, internationalization, scripting-language, and GUI features disabled
should therefore be tested alongside the relocatable staged-tree build. Accept
it only if process tracing proves that every exercised command uses the one
binary and no host program or resource, upstream Git tests pass under the
selected flags, clean-environment History behavior passes, and the shipped
corresponding source plus musl/zlib notices cover the actual static link. A
fully static glibc build is not the default recommendation because it adds
relinking/runtime questions without lowering the Node SEA and Tauri shell's
glibc floor.

### Library and reimplementation alternatives

| Alternative                                                          | Benefit                                                                                                                                                                                                      | Cost or uncertainty                                                                                                                                                                                                                                                                                                                              | Assessment                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [`isomorphic-git`](https://github.com/isomorphic-git/isomorphic-git) | Pure JavaScript, MIT-licensed, no native C++ dependency; exposes the init, add, commit, log, ref, tree, object, and blob primitives this product needs. It aims for canonical repository interoperability.   | It is a reimplementation, not canonical Git. Its own status says it is maintained by two volunteers who mostly review contributions. Replacing CLI semantics requires a new History Git Adapter plus interoperability, crash-consistency, packed-ref/object, existing-repository, corruption, concurrency, and exact-byte restore evidence.      | Credible future size/portability experiment, not the first production path.                         |
| [`libgit2`](https://github.com/libgit2/libgit2)                      | Mature portable C library with repository, object database, index, commit, reference, and revision-walk APIs; GPLv2 with a linking exception. Can be built with bundled zlib and without network transports. | Requires a Node binding/native addon or a new Rust-side service boundary. A Node addon reintroduces ABI, extraction/loading, libc, and per-target build concerns; moving Git behavior into Rust contradicts the accepted dependency direction. libgit2 also explicitly does not implement the user-facing Git CLI and may lag upstream behavior. | Technically viable but architecturally and operationally more expensive than executing bundled Git. |
| `gitoxide`/`gix` or another Rust reimplementation                    | Pure-Rust Git components could integrate naturally with a Rust shell and release target matrix.                                                                                                              | It moves canonical-history behavior across the fixed sidecar/History boundary, and Git compatibility still needs proof. This is effectively a different architecture, not merely packaging.                                                                                                                                                      | Out of scope unless the Parent Spec is revised.                                                     |

The library choices are not inherently invalid. They simply solve a larger
problem than issue #22: they replace the project's Git Adapter and its
compatibility authority. The bundled upstream executable first tests the
narrow question—can the current architecture be distributed—without mixing it
with a persistence rewrite.

## Tauri v2 and Linux target constraints

Tauri's `bundle.externalBin` is a build-time selection contract. For:

```json
{
  "bundle": {
    "externalBin": ["binaries/silksong-git-sidecar"]
  }
}
```

an x86-64 GNU/Linux build must have:

```text
src-tauri/binaries/silksong-git-sidecar-x86_64-unknown-linux-gnu
```

and an ARM64 GNU/Linux build must analogously have the
`-aarch64-unknown-linux-gnu` suffix. Tauri documents the
`binary-name-$TARGET_TRIPLE` rule and recommends obtaining the host triple with
`rustc --print host-tuple`
([Tauri sidecar guide](https://v2.tauri.app/develop/sidecar/),
[configuration reference](https://v2.tauri.app/reference/config/#bundleconfig)).
The build must use the requested Cargo target, not blindly rename with the
build host's triple.

The suffix selects the file; it does not prove the file's ABI. Validate it
with `file`, `readelf -h`, `readelf --version-info`, and `ldd` (where
applicable) before Tauri packaging. A musl-static sidecar or Git executable
could technically be staged for a GNU Tauri target, but the name must still
match the Tauri application target and the resulting mixed-libc package needs
clean-system tests.

Git's tree, runtime libraries if any, and third-party notices belong under
`bundle.resources`, not `externalBin`. Tauri supports files, directories,
globs, and explicit source-to-destination resource maps
([Tauri resource configuration](https://v2.tauri.app/reference/config/#bundleconfig)).
Rust should resolve the installed resource directory and supply exact paths to
the sidecar; neither the sidecar's current working directory nor the
executable's installed adjacency is a portable resource contract.

Linux compatibility is bounded by the most restrictive component:

- Official Node 24 x64/arm64 binaries require glibc 2.28 and kernel 4.18.
- Bun offers both glibc and musl targets, plus a baseline x64 CPU build.
- Deno lists only GNU Linux compile targets and does not publish a stable
  minimum-glibc promise in the compile reference; inspect and test the pinned
  `denort`.
- The Tauri shell and WebKitGTK stack impose their own floor. Tauri warns that
  building an AppImage on a newer base can require a newer glibc and recommends
  building on the oldest intended base; its tooling currently cannot
  cross-compile ARM AppImages
  ([Tauri AppImage documentation](https://v2.tauri.app/distribute/appimage/)).

Consequently, “Node supports glibc 2.28” is not an application compatibility
claim. Select and publish a desktop distro baseline only after the complete
Tauri package, sidecar, Git, and WebKit dependencies pass there.

## CI and reproducible packaging shape

A production pipeline should be target-matrix driven:

1. Pin and install pnpm dependencies with the repository lockfile.
2. Build and test the workspace sidecar entry.
3. Bundle one CommonJS entry and audit the bundle for unresolved filesystem
   imports and dynamic `require()` calls.
4. Fetch or cache the pinned official Node archive for the target, verify its
   checksum/signature, generate the SEA blob with the matching version, and
   inject it.
5. Build pinned upstream Git for the target with the recorded configuration,
   run upstream tests appropriate to the build, install into a staging tree,
   and inventory executable/library dependencies.
6. Copy the SEA to the exact `externalBin` target-triple path; map the private
   Git tree and notices into Tauri resources.
7. Run the packaged protocol and History acceptance workflow in a controlled
   environment with no system Node or Git, a scrubbed `PATH`, and no accidental
   access to build-machine resources.
8. Only then run `tauri build`, followed by installed/AppImage smoke tests on
   the oldest supported and a current distribution.

Use native Linux runners for each final Tauri architecture unless the bundle
format is proven cross-buildable. Deno and Bun can cross-compile their
standalone executable, and Node's blob can be injected into a foreign official
binary when caches/snapshots are disabled, but that does not cross-build the
Tauri AppImage or Git automatically. Tauri explicitly identifies the ARM
AppImage limitation, so an ARM64 native CI runner is the conservative plan.

Archive for every target:

- source revision and dirty-state assertion;
- Node/Deno/Bun, Git, bundler, Rust, Tauri, pnpm, and compiler versions;
- all build flags and target triples;
- hashes of downloaded runtimes and source archives;
- final sidecar, Git-tree, resource-tree, and package hashes and sizes;
- `file`, `readelf`, and dependency-inventory output;
- license/SBOM output; and
- clean-environment workflow timings and results.

## Redistribution and notices

This is an engineering inventory, not legal advice. Release approval should
review the exact bytes and licenses produced by the selected build.

| Component                              | First-party license evidence                                                                                                                                                                                                                                          | Packaging consequence                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node runtime and embedded dependencies | Node is MIT-licensed, and its repository `LICENSE` includes notices for externally maintained libraries ([Node `LICENSE`](https://github.com/nodejs/node/blob/main/LICENSE)).                                                                                         | Ship the exact license/notices corresponding to the pinned Node release, not only a one-line MIT label. The Node build already embeds SQLite, so there is no separate native npm addon in the preferred design.                                                                                                                    |
| Deno, if selected                      | Deno is MIT-licensed ([Deno `LICENSE.md`](https://github.com/denoland/deno/blob/main/LICENSE.md)).                                                                                                                                                                    | Generate and retain the pinned binary's full third-party inventory; the top-level MIT file alone does not enumerate V8/Rust/transitive notices.                                                                                                                                                                                    |
| Bun, if selected                       | Bun is MIT, but its official license explains that it statically links LGPL-2 JavaScriptCore/WebKit and describes the relinking obligation; it also enumerates many other linked libraries ([Bun `LICENSE.md`](https://github.com/oven-sh/bun/blob/main/LICENSE.md)). | This is materially more demanding than copying an MIT notice. Preserve the exact source/object/relink materials required by the pinned Bun release and obtain legal review before distribution.                                                                                                                                    |
| Git executable                         | Upstream Git is GPLv2, with some compatible differently licensed parts ([Git repository](https://github.com/git/git), [GPLv2 text](https://github.com/git/git/blob/master/COPYING)).                                                                                  | Ship the GPL text and provide the corresponding source for the exact binary, including local patches and reproducible build instructions. Keep the Git process a separate executable/resource. Review the final source-offer mechanism and every statically linked dependency.                                                     |
| Git dependencies                       | Upstream states zlib is mandatory and documents optional curl, expat, gettext, Perl, Tcl/Tk, Python, SSH, and shell dependencies ([Git `INSTALL`](https://github.com/git/git/blob/master/INSTALL)).                                                                   | The minimal build reduces both runtime and notice surface. Inventory the final ELF and staged tree rather than copying notices for unused defaults. Include zlib and any libc/toolchain runtime notices required by the actual build.                                                                                              |
| SQLite                                 | SQLite dedicates deliverable code to the public domain and permits binary redistribution for any purpose ([SQLite copyright](https://www.sqlite.org/copyright.html)).                                                                                                 | No separate SQLite license is required by SQLite itself, though the runtime's notices and an attribution can still identify the embedded version. A switch to `better-sqlite3` or another addon would add that package's license and native binary to the inventory.                                                               |
| Tauri and packaging tools              | Tauri is MIT or Apache-2.0 ([Tauri repository](https://github.com/tauri-apps/tauri)). `postject` is a Node-maintained build tool; its repository carries its license and vendored dependency inventory ([`postject`](https://github.com/nodejs/postject)).            | Preserve licenses for code shipped in the application. Build-only tools normally are not redistributed, but record their versions/licenses in the provenance and include any generated/runtime material their licenses require. Generate notices from both `pnpm-lock.yaml` and `Cargo.lock`; manual runtime notices are additive. |

Do not rely on a package manager's declared top-level license alone. Scan the
actual Tauri package and resource tree, and make notices available both in the
installed resources and from the application's diagnostic/about surface.

## Required local evidence before the recommendation becomes final

The prototype must answer these explicit uncertainties:

1. **SEA bundle correctness:** Can the actual sidecar dependency graph be
   bundled to CommonJS without a broken `import.meta.url`, filesystem lookup,
   workspace export, dynamic import, or Hono Node Adapter assumption?
2. **SQLite equivalence:** Does the SEA execute every public History behavior
   test using `node:sqlite`, including `using`/`Symbol.dispose`, locking,
   rebuild, concurrent read/write behavior, and process shutdown?
3. **Git tree minimum:** Which installed Git files are actually opened or
   executed by the acceptance workflow? Can `RUNTIME_PREFIX` plus the staged
   tree avoid all host paths? Is an empty explicit template safe, or should the
   upstream templates be retained?
4. **ELF closure:** What do `readelf`, `ldd`, and process tracing show for both
   SEA and Git? Are zlib, libgcc/libstdc++, libc, the dynamic loader, or any
   other libraries unexpectedly resolved from the clean system?
5. **Libc and CPU floor:** What is the oldest complete Linux environment that
   runs the Tauri package? Test x86-64 without AVX2 where relevant and test
   ARM64 separately. Do not infer the App's floor from one runtime's docs.
6. **Clean-environment behavior:** With system `node` and `git` absent and
   `PATH` scrubbed, can the artifact initialize/open, commit, query, restore
   exact Encoded Save bytes, and shut down cleanly?
7. **Protocol/lifecycle:** Are stdout and stderr uncontaminated? Does the Rust
   supervisor detect an unexpected exit and complete graceful shutdown while a
   Git/SQLite observation or HTTP request is active?
8. **Resources in every bundle:** Do unpacked development, installed package,
   and AppImage modes resolve the same private Git and notice resources with
   executable permissions intact?
9. **Measured cost:** Record cold/warm startup, first initialization, commit,
   representative query, restore, and active-work shutdown timing; peak RSS;
   uncompressed and packaged sizes; and the size attributable to SEA, Git, and
   notices. Compare Deno only if Node SEA misses an acceptance threshold.
10. **Reproducibility and licenses:** Can CI rebuild byte-identical or
    explainably different artifacts from pinned inputs, and does the produced
    notice/source bundle cover the exact Node, Git, zlib/libc, Tauri, Rust, and
    npm dependency closure?

## Provisional decision

Proceed with **Node 24 LTS SEA plus a pinned, minimal, relocatable upstream Git
distribution in Tauri resources**. This best preserves the existing deep
Module boundaries and tests the distribution question without simultaneously
replacing the runtime, SQLite Adapter, or Git semantics.

Keep **Deno compile** as the fallback experiment if Node SEA fails on
reproducibility, startup, artifact-size, or SEA-specific bundling grounds. Deno
has enough documented Node and `node:sqlite` compatibility to merit a measured
comparison, but not enough project-specific evidence to displace native Node
semantics preemptively.

Do not select **Bun compile** for the unchanged sidecar while Bun officially
lacks `node:sqlite`. Do not select deprecated **`pkg`**. Do not replace
canonical Git with isomorphic-git, libgit2, or a Rust reimplementation inside
issue #22 unless the bundled upstream Git approach fails a recorded acceptance
criterion and the resulting architecture change is accepted separately.
