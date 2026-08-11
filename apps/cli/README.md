# `@silksong-git/cli`

Local save history, semantic inspection, and restore tools for _Hollow Knight:
Silksong_. Saves are processed locally: the CLI has no telemetry or analytics
and does not upload saves.

## Install

Global installation is the primary workflow:

```sh
npm install --global @silksong-git/cli
# or
pnpm add --global @silksong-git/cli
```

Try the CLI without keeping a global installation for a one-shot workflow:

```sh
npx @silksong-git/cli --help
# or
pnpm dlx @silksong-git/cli --help
```

The CLI requires Node.js 24 or newer and Git on `PATH`. Windows and Linux are
supported. macOS is expected to be compatible but is not currently release
verified. npm and pnpm are supported; Yarn and Bun are best effort.

## Commands

`silksong-git` is the primary command. `ssgit` is a convenience alias.

```sh
silksong-git --help
silksong-git --version
silksong-git save snapshot save.dat --json
silksong-git repo init --save save.dat --repo ./save-history
silksong-git history checkpoint --repo ./save-history
silksong-git watch start --repo ./save-history --http
```

Use command and group `--help` output for the complete syntax. The maintained
[CLI reference](https://github.com/ffff2004/silksong-git/blob/main/docs/reference/cli.md)
documents behavior, side effects, and exit statuses.

All save decoding, semantic mapping, Git history, and SQLite indexing happens
on the local machine. The optional local HTTP adapter is authenticated with a
per-session credential and listens only on IPv4 loopback. Mapping URLs are
descriptive metadata; the CLI does not automatically request them.

## Support and security

Use [GitHub Issues](https://github.com/ffff2004/silksong-git/issues) for normal
support and bug reports. Report security vulnerabilities through
[GitHub Private Vulnerability Reporting](https://github.com/ffff2004/silksong-git/security/advisories/new),
not a public issue.

See the
[CLI changelog](https://github.com/ffff2004/silksong-git/blob/main/apps/cli/CHANGELOG.md)
for release notes. Published release tags use `cli-v<version>`.

## Credits and legal

Silksong Git is based on the
[silksong-tracker](https://github.com/th3r3dfox/silksong-tracker) project and
preserves the work of its contributors. That project was inspired by
[Hollow Knight Save Analyzer](https://reznormichael.github.io/hollow-knight-completion-check/).

This is an unofficial fan project. It is not affiliated with or endorsed by
Team Cherry and is not official game support. Game names, text, and related
intellectual property belong to their respective owners.

The package is distributed under the [MIT License](./LICENSE).
