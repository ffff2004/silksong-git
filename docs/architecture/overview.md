# System Architecture Overview

> **Migration status:** compatibility stub.

## Current Authority

Read [`save-history-design.md`](../save-history-design.md), the
[workspace architecture ADR](../adr/0011-workspace-package-architecture.md),
and the guardrails in [`AGENTS.md`](../../AGENTS.md).

## Intended Responsibility

This document will describe the current package topology, dependency direction,
Git and SQLite data ownership, principal end-to-end flows, and cross-Module
invariants.

It will link to capability architecture, ADRs, and live contracts rather than
copying their detailed decisions or interfaces.
