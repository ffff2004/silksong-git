# Local History Watch Process Architecture

> **Migration status:** compatibility stub.

## Current Authority

Read the Local History Watch Process and Local HTTP Adapter sections of
[`save-history-design.md`](../save-history-design.md),
[ADR-0008](../adr/0008-one-local-process-owns-watching-and-local-history-api.md),
and [ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md).

## Intended Responsibility

This document will describe singleton ownership, `watch.lock`, the startup
Project Config snapshot, event scheduling, stability checks, dirty-bit
single-flight behavior, deferred observations, structured process status and
events, failure classes, optional HTTP listener lifecycle, and graceful
shutdown.

It will delegate observation and `write.lock` semantics to the Save History
Module and exact HTTP protocol details to the Local HTTP API Reference.
