# Tauri Linux packaging prototype results

> **THROWAWAY PROTOTYPE for issue #42.** These findings constrain issue #27
> and the final Linux technical preview. This code is not the production
> Desktop application, final sidecar protocol, or implemented-architecture
> authority.

## Verdict

The issue #22 Linux x86-64 Node SEA and private static Git runtime can be
packaged in a real Tauri v2 AppImage and supervised by an installed Rust shell.
The packaged workflow does not need system Node.js or Git.

The proof keeps the accepted boundary:

- Tauri `externalBin` names the fixed `binaries/silksong-git-sidecar`; the build
  stages the generated source artifact with Tauri's
  `-x86_64-unknown-linux-gnu` suffix.
- Private Git, Node/Git notices, and a test Encoded Save are Tauri resources.
- Rust resolves the external binary beside the installed App executable and
  resolves Git/fixture paths from Tauri's installed resource directory. It
  never relies on the repository or current working directory.
- Rust passes an absolute private Git `bin` directory. The SEA then replaces
  `PATH` with only that directory, preserving the #22 proof.
- The WebView has intent-level application commands and only
  `core:window:allow-close`, needed by the drain proof. It does not receive the
  broad `core:default` set, and no shell, process, filesystem, or arbitrary
  HTTP plugin exists.

## Reproduction

From the repository root:

```sh
pnpm prototype:tauri-linux
```

The command:

1. stages the ignored #22 artifact (or rebuilds it if absent);
2. builds a release AppImage;
3. copies it to a path containing spaces and non-ASCII characters;
4. builds a clean Arch Linux GUI runner;
5. runs that container with networking disabled and verifies both the visible
   tracer and active-work window close; and
6. writes machine evidence to the ignored
   `apps/tauri-linux-prototype/dist/evidence/summary.json`.

## Installed layout and configuration

The representative AppImage/AppDir layout is:

```text
usr/bin/
├── silksong-git-tauri-linux-prototype
└── silksong-git-sidecar
usr/lib/Silksong Git Tauri Linux Prototype/resources/
├── private-git/bin/git
├── fixtures/minimal-valid-save.dat
└── notices/
    ├── NODE-LICENSE
    ├── GIT-COPYING
    └── PROTOTYPE-NOTICES.md
```

The source configuration is
[`src-tauri/tauri.conf.json`](src-tauri/tauri.conf.json), and the complete
machine inventory including byte sizes is in generated `summary.json`. The
verifier generates that inventory by extracting the completed AppImage itself;
it does not treat Tauri's host-side AppDir staging tree as installed evidence.

Arch Linux's current libraries use ELF RELR sections that the old `strip`
inside Tauri's downloaded linuxdeploy AppImage cannot understand. Setting
`NO_STRIP=1` makes linuxdeploy retain those already-built libraries and
successfully produce the AppImage. This is a CI packaging requirement until
the linuxdeploy toolchain handles current Arch ELF sections. It also avoids
trying to strip the intentionally static private Git executable.

## Lifecycle and public behavior

The packaged UI drives protocol-v1 JSONL through Rust and visibly reports:

1. initialization of a real Save History Repository;
2. a committed Raw Save Observation;
3. query returning exactly one observation;
4. explicit graceful shutdown;
5. a new SEA process reopening the existing repository;
6. byte-exact restore;
7. unexpected SIGKILL reported as `unexpectedExit`, with no false `stopped`;
   and
8. forced process-group cleanup leaving no sidecar or bundled-Git process.

The separate close probe starts an operation, waits for the sidecar's
`beforeObservation` phase, requests window close, sends JSONL `shutdown`, and
allows App exit only after `operationCompleted`, `stopped`, and process exit.
The close evidence records that ordering and elapsed drain time.

Every sidecar starts in its own Linux process group and receives
`PR_SET_PDEATHSIG(SIGKILL)` as a last-resort parent-death guard. A
prototype-only `holdGit` command makes the SEA spawn its private bundled
`git hash-object --stdin` and keep that child alive. Rust verifies the live
child PID is a member of the sidecar process group and that `/proc/<pid>/exe`
matches the installed private Git path. Explicit forced cleanup then kills the
complete group and proves both PIDs, all group members, and the private-Git
executable path are absent.

Relevant paths in both the installed bundle and History workspace contain
spaces and Chinese characters. The exact installed resource directory observed
inside the AppImage mount is retained in machine evidence.

## Clean environment and measurements

The verifier uses an Arch Linux container containing only GUI/runtime test
support, not Node.js or Git. Before launch it proves both commands absent. The
actual run uses Xvfb, the real AppImage, and `podman run --network none`.

Representative measurements are filled from the latest checked
`dist/evidence/summary.json`; they are feasibility evidence, not budgets:

- AppImage: approximately 135 MiB.
- Complete packaged tracer: approximately 2 seconds on the development host;
  clean-container timing is recorded per run.
- Encoded Save/restore SHA-256:
  `db1adc07dd5348669da26177760c8dd7dd5b259506b3d4b03806c6ad596e3b58`.

## Constraints for issue #27 and the Linux preview

- Preserve `externalBin` target-suffix staging and installed-path resolution.
  Never infer runtime paths from source layout or CWD.
- Preserve the Rust-shell/sidecar boundary. Git, SQLite, observation, query,
  restore, and repository rules remain behind TypeScript History Interfaces.
- Keep WebView capability intent-level. Do not add generic shell/process,
  filesystem, or arbitrary HTTP permission to make lifecycle work easier.
- Production should replace these prototype commands with #20's versioned
  machine Interface and Repo Session design; do not evolve this spike in place.
- Use a process group plus a parent-death strategy, and keep graceful drain as
  the normal close path. Preserve a production equivalent of this prototype's
  non-vacuous live-Git-descendant cleanup test.
- Build the Linux preview in a pinned older compatible build image instead of
  current Arch if broad glibc portability is required. This prototype's SEA
  already has the #22 glibc 2.28 floor, but the Rust/AppImage host ABI must also
  be controlled.
- Pin/cache Tauri CLI and Rust crates, linuxdeploy helpers, the #22 Node/Git
  inputs, pnpm store, Cargo registry/target, and the clean GUI image in CI.
  Retain the AppImage hash, installed inventory, clean environment report,
  screenshot/XWD, lifecycle JSON, and process scan.
- Continue to treat #22's exact static Git as spike-only: its two upstream
  locale install-check failures and complete corresponding-source/static
  dependency inventory remain unresolved for production redistribution.

## Deliberately out of scope

This does not create production `apps/desktop` or `apps/desktop-sidecar`,
implement Repo Session/HTTP handoff, define the final JSONL protocol, provide
product UI, prove other package formats/platforms, add signing/updating, or
change authoritative architecture documents.
