# History Git Compatibility Reference

This reference owns the Git feature surface used by the public History
Interface. It is the compatibility authority for the Linux Git qualification
described by issue [#61](https://github.com/ffff2004/silksong-git/issues/61).
The package-root exports and behavior tests remain the authority for History
semantics; this document records only the Git boundary those semantics depend
on.

## Supported policy

The qualified Git core policy is `>=2.34.0 <3.0.0`. The lower bound is based
on the complete History and Repo Session behavior suites passing with upstream
Git 2.34.0. The ordinary dynamically linked glibc/Linux build is the
portability authority. A static musl build is useful supplemental evidence but
does not qualify Linux compatibility by itself.

## Application Git surface

History invokes the executable named `git` with `cwd` set to the absolute Save
History Repository path. Every invocation uses `execFile`, so arguments are
passed as individual argv entries and no shell parsing is part of the
contract. A successful command has exit status 0. Git stdout is trimmed by
text readers; Git stderr is retained only for error classification and the
resulting error cause.

| Operation              | Exact argv after any managed `-c` arguments                                                                                  | Success assumption                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initialize             | `init`                                                                                                                       | Exit 0; no output is consumed. The repository becomes a work tree with an unborn `HEAD`.                                                                                                                    |
| Stage observation      | `add`, then `.gitignore`, `.gitattributes`, `.silksong-git/config.json`, `save.dat`, `decoded-save.json`, `observation.json` | Exit 0; no output is consumed. The listed paths are staged.                                                                                                                                                 |
| Commit observation     | `commit`, `-m`, `<deterministic observation message>`                                                                        | Exit 0; no output is consumed. The commit is written with the observation timestamp supplied through the environment.                                                                                       |
| Read current head      | `rev-parse`, `--verify`, `HEAD`                                                                                              | Exit 0 and one commit object name on stdout. Exit 128 with the localized-to-C diagnostic `Needed a single revision` or `unknown revision or path not in the working tree` is interpreted as an unborn head. |
| Enumerate observations | `rev-list`, `--reverse`, `HEAD`                                                                                              | Exit 0 and one commit object name per line. Empty trimmed stdout is treated as no commits.                                                                                                                  |
| Check work-tree shape  | `rev-parse`, `--is-inside-work-tree`                                                                                         | Exit 0 and trimmed stdout exactly `true`; any failure or other output means the path is not a usable work-tree repository.                                                                                  |
| Validate integrity     | `fsck`, `--no-dangling`, `--no-reflogs`                                                                                      | Exit 0. Stdout is not parsed. Any failure is either an invalid repository during strict inspection or an advisory integrity warning during read-only snapshot/migration work.                               |
| Read commit metadata   | `show`, `-s`, `--format=%H%x00%h%x00%cI`, `<ref>^{commit}`                                                                   | Exit 0 and exactly three NUL-separated fields: full object name, abbreviated object name, and committer date in Git's `%cI` strict ISO 8601 format.                                                         |
| Read an artifact blob  | `show`, `<commit-ref>:<artifact-path>`                                                                                       | Exit 0 and raw stdout bytes, capped at 10 MiB by the Node child-process adapter. The bytes are returned unchanged.                                                                                          |

The `<ref>` and `<commit-ref>` values are supplied by public History inputs or
internal commit references. A Git exit status 128 with one of the recognized
English C-locale diagnostics `unknown revision or path not in the working
tree`, `bad revision`, `ambiguous argument`, `invalid object name`, or `Needed
a single revision` becomes `InvalidCommitRefError`. A status-128 blob lookup
whose stderr contains `does not exist in` or `exists on disk, but not in`
becomes `ObservationNotFoundError`. Other failures remain Git command errors.

The managed stage/commit operations prepend these command-scoped `-c` pairs:

```text
-c user.name=silksong-git
-c user.email=silksong-git@example.invalid
-c commit.gpgSign=false
-c core.hooksPath=<repo>/.silksong-git/no-hooks
-c core.attributesFile=<repo>/.silksong-git/global-attributes
```

Before any managed operation, History creates `.silksong-git/`,
`.git/info/`, `.silksong-git/no-hooks/`, an empty
`.silksong-git/global-attributes`, and the default attributes files. The
tracked observation paths and ignored runtime paths are defined by
`packages/history/src/layout.ts`.

## Git environment and configuration

The current History adapter starts from `process.env`, overlays operation
values, and then fixes these values for every application Git invocation:

```text
GIT_ATTR_NOSYSTEM=1
GIT_CONFIG_NOSYSTEM=1
GIT_TERMINAL_PROMPT=0
LANG=C
LC_ALL=C
LC_MESSAGES=C
LANGUAGE=C
```

Observation commits additionally pass the explicit History-owned values
`GIT_AUTHOR_DATE=<observedAt>` and
`GIT_COMMITTER_DATE=<observedAt>`. The fixed values win over caller-provided
values. The current adapter still inherits other ambient `GIT_*` keys; the
stronger removal of all ambient `GIT_*` keys and the `GIT_CONFIG_GLOBAL` null
device described by parent issue #57 are a parent-runtime responsibility, not
a hidden qualification assumption.

Repository-local Git configuration is therefore present, but managed writes
override identity, signing, hooks, and the global attributes file. The
qualification harness removes all ambient `GIT_*` keys and sets `PATH` to only
the candidate Git directory. This makes the candidate/version evidence
reproducible without claiming that the harness itself implements the History
adapter's future parent-ticket hardening.

## Test-only Git surface

The History tests also use Git to construct hostile repository fixtures and to
inspect exact bytes. These calls are not application runtime requirements:

- `config user.name`, `config user.email`, and `config user.useConfigOnly`
  make repository identity unusable so managed identity is tested.
- `config commit.gpgSign` and `config gpg.program` make signing unavailable so
  managed signing suppression is tested.
- `config core.hooksPath` points to a failing `prepare-commit-msg` hook so the
  managed no-hooks override is tested.
- `config filter.corrupt-save.clean` and `config filter.corrupt-save.smudge`
  install a deliberately corrupting filter so the managed attributes override
  is tested.
- `config core.autocrlf` and `config core.eol` create a CRLF configuration so
  LF-normalized JSON attributes are tested.
- `hash-object`, `-w`, `<path>` writes an unreachable object which is then
  damaged to exercise the advisory `fsck` path.
- Test helpers use `show`, `<ref>:<artifact-path>` to compare committed bytes;
  this has the same Git blob contract as the application adapter but is not an
  additional runtime command.

These fixture commands are in `packages/history/src/git-environment.test.ts`
and `packages/history/src/index.test.ts`. They are intentionally excluded from
the application command table above.

## Public call paths

The public package-root operations reach the surface as follows:

- `initSaveHistory` invokes `init`, creates the managed files, and rebuilds the
  SQLite read model.
- `observeSave`, the watcher, and Repo Session observation invoke `rev-parse`,
  then `add` and `commit`, followed by `show` for the committed metadata.
- `queryHistory`, `queryRawObservations`, `diffCommits`,
  `searchSemanticEvents`, `getSaveState`, and repository inspection reach the
  read commands listed above through the read model and compatibility paths.
- `readEncodedSave`, `restoreEncodedSave`, and the HTTP export/restore routes
  use `show <ref>:<path>` for exact artifact bytes and `show -s ...` for commit
  metadata.
- `openRepoSession` first inspects the repository, then delegates all History
  Git work to the same adapter. HTTP itself does not invoke Git.

The concrete adapter is [`packages/history/src/git-store.ts`](../../packages/history/src/git-store.ts);
the public entry points are [`packages/history/src/index.ts`](../../packages/history/src/index.ts)
and [`packages/history/src/history-interface.ts`](../../packages/history/src/history-interface.ts).

## Qualification harness

Run the reusable harness from the repository root with a candidate Git `bin`
directory:

```sh
pnpm qualify-git \
  --git-bin /absolute/path/to/git-prefix/bin \
  --expect-version 2.34.0
```

The harness first runs `git --version`, then runs every History test and every
Repo Session test through the absolute Node and tsx entries. The child `PATH`
contains only the supplied Git directory; ambient `GIT_*` keys are removed,
while ordinary environment values remain inherited. Test files are enumerated
by the harness, so the command does not depend on shell glob expansion.

The required representative workflow is covered by the public-interface
History and Repo Session suites: repository initialization, observation,
read-model query/export, restore, watcher lifecycle, and graceful session
shutdown. Future qualification runs should record the candidate's exact
`git version` output, build/provenance, harness command, and both suite counts
in the relevant issue.

## Qualification evidence for 2.34.0

On 2026-08-14, upstream Git v2.34.0 was built from the official source archive
with the ordinary dynamic glibc toolchain and passed the harness with:

```text
History: 77 passed, 0 failed
Repo Session: 42 passed, 0 failed
```

The supplemental static musl Git 2.34.0 candidate also passed `77` History and
`42` Repo Session tests. It used `NO_CURL=YesPlease`; silksong-git exercises
only local Git operations, so network transports are not part of this
qualification surface.
