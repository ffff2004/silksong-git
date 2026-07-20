# CLI Reference

The package installs the same CLI as `silksong-git` and `ssgit`. The forms
below are the currently implemented command contract. Exact callable result
types remain owned by the public
[`@silksong-git/history` Interface](../../packages/history/src/index.ts) and
[`@silksong-git/core` Interface](../../packages/core/src/index.ts).

The CLI parses arguments and renders results; save-history rules remain in
History and save interpretation remains in Core. It does not expose Git
commands, SQLite tables, repository layout helpers, or internal handlers.

## Command Summary

```txt
silksong-git repo init --save <save.dat> --repo <history-repo> [--json]

silksong-git save decode <save.dat> [--compact] [--out <decoded-save.json>] [--schema-check]
silksong-git save snapshot <save.dat> --json

silksong-git history list [--repo <history-repo>] [--limit <n>] [--cursor <cursor>] [--include-filtered] [--json]
silksong-git history diff <from> <to> [--repo <history-repo>] [--include-filtered] [--json]
silksong-git history search [--repo <history-repo>] [--event <text>] [--item-id <id>] [--label <text>] [--type <type>] [--status-to <status>] [--direction <direction>] [--include-filtered] [--json]
silksong-git history checkpoint [--repo <history-repo>] [--message <text>] [--allow-unchanged] [--json]
silksong-git history restore <commit> (--to <path> | --in-place --confirm-in-place) [--repo <history-repo>]
silksong-git history rebuild [--repo <history-repo>] [--json]

silksong-git watch start [--repo <history-repo>] [--jsonl] [--http] [--port <port>]
```

Commander also supplies `-h, --help` on the program, groups, and commands.
There is currently no `ui open` command or CLI export command. Delivery work
that changes the command set is tracked through the [Roadmap](../roadmap.md).

## Repository Context

Every `history` command and `watch start` resolves one Save History Repository
in this order:

1. `--repo <history-repo>`, resolved to an absolute path;
2. the nearest current or parent directory containing
   `.silksong-git/config.json`; or
3. failure because a repository path is required.

An explicit `--repo` always wins. It must already identify a Save History
Repository; an invalid path is not initialized automatically. Cwd discovery
does not treat an unrelated Git repository as a Save History Repository.
`repo init` is different because it creates the repository and therefore
always requires an explicit `--repo`.

One-shot history commands are Offline Commands: they call the public History
Interface directly and do not require `watch start` to be running. History
serializes repository mutations and in-place restore with watcher work through
the repository write lock. An explicit restore to an external Restore Target
is a filesystem write but does not take that repository lock. See the
[Save History Module](../architecture/save-history-module.md#caller-and-process-boundary).

## Commands

### `repo init`

```txt
silksong-git repo init --save <save.dat> --repo <history-repo> [--json]
```

Creates a Save History Repository and its Project Config. It does not decode
the Watched Save or create an initial Raw Save Observation.

- `--save <save.dat>` is required. The path must exist and identify a file; the
  absolute path is stored as the Watched Save.
- `--repo <history-repo>` is required. A missing directory is created; an
  existing directory must be empty.
- `--json` writes the public initialization result as JSON to stdout. Without
  it, stdout contains a human-readable summary and checkpoint hint.

### `save decode`

```txt
silksong-git save decode <save.dat> [--compact] [--out <decoded-save.json>] [--schema-check]
```

Decodes one Encoded Save for raw debugging without creating or changing a
history repository. The output is the Decoded Save object, not a semantic
contract.

- `<save.dat>` is the required Encoded Save path.
- `--compact` emits single-line rather than pretty JSON.
- `--out <decoded-save.json>` writes JSON to that explicit path instead of
  stdout. The current behavior replaces an existing file at that path.
- `--schema-check` additionally reports schema recognition on stderr. An
  unrecognized schema remains a successful raw decode.

### `save snapshot`

```txt
silksong-git save snapshot <save.dat> --json
```

Decodes, parses, and maps one Encoded Save through Core without writing Git or
SQLite. `--json` is currently required and writes the Semantic Snapshot to
stdout; invoking the command without it is a usage error.

### `history list`

```txt
silksong-git history list [--repo <history-repo>] [--limit <n>] [--cursor <cursor>] [--include-filtered] [--json]
```

Reads Semantic Event history from the Semantic Read Model.

- `--limit <n>` sets a page size from 1 through 1000.
- `--cursor <cursor>` continues from an opaque cursor returned by an earlier
  JSON result.
- `--include-filtered` includes events hidden by Display Semantic Event
  Filters.
- `--json` writes the public history result. Text mode writes one event per
  line or `no semantic events`.

The CLI does not currently expose Raw Save Observation listing.

### `history diff`

```txt
silksong-git history diff <from> <to> [--repo <history-repo>] [--include-filtered] [--json]
```

Compares the Semantic Snapshots at two required commit refs. Use
`--include-filtered` to include normally hidden events. `--json` writes the
public diff result; text mode writes event lines or `no semantic changes`.

### `history search`

```txt
silksong-git history search [--repo <history-repo>] [--event <text>] [--item-id <id>] [--label <text>] [--type <type>] [--status-to <status>] [--direction <direction>] [--include-filtered] [--json]
```

At least one query flag is required. Multiple query flags are combined in one
search.

- `--event <text>` is the CLI's free-text convenience query.
- `--item-id <id>`, `--label <text>`, and `--type <type>` are structured
  semantic fields.
- `--status-to <status>` accepts `accepted`, `done`, `missing`, or `unknown`.
- `--direction <direction>` accepts `neutral`, `progression`, or `regression`.
- `--include-filtered` includes events hidden by Display Semantic Event
  Filters.
- `--json` writes the public search result. Text mode writes matching event
  lines or `no matching semantic events`.

Structured fields are the stable programmatic search seam; free text is an
interactive convenience, as recorded by
[ADR-0010](../adr/0010-first-version-cli-command-set.md).

### `history checkpoint`

```txt
silksong-git history checkpoint [--repo <history-repo>] [--message <text>] [--allow-unchanged] [--json]
```

Attempts a Manual Checkpoint of the current Watched Save through History.

- `--message <text>` records an optional checkpoint message in Observation
  Metadata.
- `--allow-unchanged` permits an observation even when Encoded Save bytes
  match the previous observation.
- `--json` writes the public observation result. Text mode distinguishes
  committed and skipped outcomes and suggests `--allow-unchanged` for an
  unchanged skip.

A Manual Checkpoint bypasses the Minimum Commit Interval, but not decoding,
repository locking, or unchanged-byte suppression unless the explicit option
is present. A successfully decoded unrecognized schema can still be committed
as an Unrecognized Schema Observation.

### `history restore`

```txt
silksong-git history restore <commit> --to <path> [--repo <history-repo>]
silksong-git history restore <commit> --in-place --confirm-in-place [--repo <history-repo>]
```

Restores the exact committed Encoded Save bytes. Exactly one target mode is
required; the command currently has human-readable output only.

- `--to <path>` writes an explicit Restore Target. It refuses to replace an
  existing target.
- `--in-place` selects the Watched Save from Project Config. It is valid only
  with `--confirm-in-place` and cannot be combined with `--to`.
- `--confirm-in-place` is invalid without `--in-place`.

In-place restore is the highest-risk CLI operation. History creates a
byte-for-byte backup when the Watched Save exists, then writes and verifies the
selected bytes under the repository write lock. If the Watched Save is absent,
the restore can complete without a backup. Restore itself does not create a
Raw Save Observation. Full ownership and failure semantics are in the
[Save History Module](../architecture/save-history-module.md#restore) and
[ADR-0007](../adr/0007-restore-requires-explicit-target-or-in-place-confirmation.md).

### `history rebuild`

```txt
silksong-git history rebuild [--repo <history-repo>] [--json]
```

Recreates the SQLite Semantic Read Model from canonical Git observations under
the current Core interpretation. It does not rewrite Git history and succeeds
with zero counts on an empty repository. `--json` writes the public rebuild
result; text mode reports observation and event counts.

### `watch start`

```txt
silksong-git watch start [--repo <history-repo>] [--jsonl] [--http] [--port <port>]
```

Starts the long-running Local History Watch Process. Startup may immediately
commit the current Watched Save, and later stable changes can mutate Git and
the Semantic Read Model according to Capture Policy.

- `--jsonl` writes one compact machine-readable event per line to stdout.
  Without it, timestamped diagnostic events go to stderr and stdout remains
  unused.
- `--http` starts the authenticated loopback Local HTTP Adapter inside the same
  process. Its endpoint and per-start token are reported in the `started`
  event.
- `--port <port>` selects an integer port from 1 through 65535 and requires
  `--http`. Without `--port`, the operating system chooses an available port.

The process runs until stopped by `SIGINT`, `SIGTERM`, or `SIGBREAK`, or until
a fatal process/output failure begins shutdown. The current scheduling and
shutdown guarantees, including known gaps, live in the
[Local History Watch Process architecture](../architecture/local-history-watch-process.md).

## Safety and Side Effects

| Class                      | Commands and effects                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only                  | `save decode`, `save snapshot`, `history list`, `history diff`, and `history search` only read inputs or repository state when used without a file-output option.                             |
| Explicit filesystem write  | `save decode --out` writes or replaces exactly the requested JSON path. `history restore --to` writes a new explicit target and refuses an existing path.                                     |
| Repository creation        | `repo init` creates or initializes the explicit empty repository directory and writes Project Config; it does not observe the save.                                                           |
| Repository mutation        | `history checkpoint` may commit Git artifacts and update SQLite. `history rebuild` replaces only the rebuildable SQLite read model. Both use History's write lock.                            |
| Process start and mutation | `watch start` acquires process ownership and may continuously commit observations and update SQLite. `--http` also starts a loopback listener; it does not create another persistence writer. |
| High-risk in-place restore | `history restore --in-place --confirm-in-place` backs up, overwrites, and verifies the configured Watched Save under History's write lock.                                                    |

Display Semantic Event Filters affect only list, diff, and search visibility;
they never decide checkpoint or watcher commits and never delete events from
SQLite.

## Output Contracts

| Mode                  | Contract                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human-readable text   | Default for most one-shot commands. Intended for interactive use; exact wording and layout are not a byte-stable automation contract.                                            |
| `--json`              | One pretty-printed JSON value on stdout for supported commands, normally the corresponding public Interface result. `save snapshot` currently requires this mode.                |
| Raw decode JSON       | `save decode` always emits the raw Decoded Save object, pretty by default or compact with `--compact`, either to stdout or `--out`. This raw shape is not a stable semantic API. |
| `watch start --jsonl` | Compact JSON Lines on stdout. Events are adapter summaries, not copies of internal watch-process objects.                                                                        |

In JSONL mode, `started` includes repository, Watched Save, Capture Policy,
and optional HTTP endpoint/token fields. Observation lines identify their
cause and a committed, skipped, or Watcher Error summary. Fatal HTTP/process
errors and stopping lifecycle events are likewise typed lines. The HTTP token
appears only in the started event and must be treated as a secret.

Diagnostics and errors use stderr. The default watch mode is the exception to
the usual stdout text convention: all of its timestamped runtime events are
diagnostic stderr output.

## Errors and Exit Status

| Exit | User-level meaning and current examples                                                                                                                                                                                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success, including a valid query with no matching events, an unchanged checkpoint skip, and clean watch shutdown. `save decode --schema-check` also exits successfully when decoding works but the schema is unrecognized.                                                                                                             |
| `1`  | Usage, configuration, or general command failure: invalid/missing repository context; invalid search, pagination, target, or HTTP options; invalid commit refs; existing restore targets; restore backup/write/verification failures; invalid repo initialization; watch ownership/listener startup, fatal runtime, or output failure. |
| `2`  | The Encoded Save could not be decoded by `save decode` or `save snapshot`, or the checkpoint candidate could not be read or decoded; no decoded/snapshot/checkpoint output is produced.                                                                                                                                                |
| `3`  | `save snapshot` decoded the file but did not recognize its Save Schema Version. Stderr suggests `save decode` for raw inspection.                                                                                                                                                                                                      |
| `4`  | A one-shot History mutation could not acquire the Save History Repository write lock.                                                                                                                                                                                                                                                  |
| `5`  | The Semantic Read Model required by a history query is unavailable. Stderr suggests `history rebuild`.                                                                                                                                                                                                                                 |

History commands normalize repository-context errors to exit 1. `watch start`
currently lets a repository-context error reach the top-level process rather
than formatting it through the History command error mapper; callers should
rely on its nonzero exit, not stable diagnostic wording, for that case.

Commander reports unknown commands/options and missing required arguments as
usage failures. Unexpected filesystem or runtime exceptions that are not one
of the mapped cases also terminate unsuccessfully; their diagnostic text is
not a stable CLI contract.
