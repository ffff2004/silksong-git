# Linux sidecar distribution prototype

> **THROWAWAY PROTOTYPE for issue #22.** This directory is primary evidence for
> a packaging decision, not the production Desktop sidecar.

## Question

Can the current TypeScript History runtime and the Git executable it delegates
to be delivered as a target-specific Linux sidecar that a Tauri parent can
spawn on a machine with no system Node.js or Git, while preserving real
repository, observation, query, byte-exact restore, and graceful-shutdown
behavior?

Run the complete build and clean-environment verification with:

```sh
pnpm prototype:linux-sidecar
```

The prototype exposes three workflow commands: `exercise`, `reopen`, and
`shutdown`. Issue #42 adds a narrowly scoped `holdGit` test hook so the packaged
Rust parent can prove non-vacuous process-group cleanup while the private Git
descendant is alive. These are spike controls, not a proposal for the
production Repo Session protocol.

See [RESULTS.md](RESULTS.md) for the measured verdict and [RESEARCH.md](RESEARCH.md)
for the primary-source comparison of packaging alternatives. Redistribution
constraints for the exact prototype inputs are inventoried in
[NOTICES.md](NOTICES.md).
