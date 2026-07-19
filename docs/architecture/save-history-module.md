# Save History Module Architecture

> **Migration status:** compatibility stub.

## Current Authority

Read the Data Ownership, Repository Layout, Observation Flow, Capture Policy,
History Module Interface, and Restore Safety sections of
[`save-history-design.md`](../save-history-design.md), the relevant
[ADRs](../adr/README.md), and the public
[`@silksong-git/history` Interface](../../packages/history/src/index.ts).

## Intended Responsibility

This document will describe one Save History Repository per Watched Save, Git
Raw Save Observations, the rebuildable SQLite Semantic Read Model, observation
and Capture Policy semantics, `write.lock`, query/diff/search/save-state/export
workflows, and restore safety.

The Local History Watch Process is a caller and orchestrator of these behaviors.
Its scheduling and process lifecycle belong in the dedicated runtime document.
