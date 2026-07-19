# Local HTTP API Reference

> **Migration status:** compatibility stub.

## Current Authority

Read the Local HTTP Adapter section of
[`save-history-design.md`](../save-history-design.md),
[ADR-0018](../adr/0018-secure-versioned-local-http-adapter.md), and the runtime
[HTTP contract](../../packages/history/src/http-contract.ts) and
[wire schemas](../../packages/history/src/http-wire.ts).

Run `pnpm generate:openapi` to generate the ignored OpenAPI 3.1 artifact from
the executable contract.

## Intended Responsibility

This document will explain compatibility discovery, authentication, protocol
versioning, the generated contract workflow, and where clients find exact
request, response, and error schemas.

It will not manually duplicate the complete route, DTO, or error tables.
