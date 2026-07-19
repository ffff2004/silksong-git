# Pre-Solid Web Overview

> **Legacy reference:** this page describes the Web application before its
> Solid rewrite. It is migration history, not current architecture.

The pre-Solid application was a browser-only tracker implemented as one
client-side DOM application. A user uploaded an Encoded Save or Decoded Save
JSON; browser code decoded and parsed it, combined raw fields with bundled JSON
item catalogues, and directly updated Progress, Map, and Raw Save Data views.
There was no Save History Repository, Semantic Read Model, Local History Watch
Process, or local HTTP client.

This history remains useful for two compatibility facts:

1. Static upload and the three original views were product behavior that the
   Solid migration intentionally preserved.
2. The bundled item catalogues and raw-field interpretation were the source
   material extracted behind the reusable Semantic Core Interface.

The historical implementation initially lived in a single Web source tree and
was moved under `apps/web` during the workspace migration before being replaced
by Solid components, stores, and routes. Historical names such as `main.ts`,
`save-data.ts`, `save-parser.ts`, `renderGenericGrid`, and module-level
`currentLoadedSaveData` describe that removed implementation and must not be
used to locate current behavior.

For current sources of truth, use:

- [Web architecture](../../architecture/web.md) for the Solid runtime, modes,
  routes, and state ownership;
- [Semantic Core architecture](../../architecture/semantic-core.md) for
  decoding, parsing, Mapping Data, Semantic Snapshots, and Semantic Events; and
- the live public
  [`@silksong-git/core` Interface](../../../packages/core/src/index.ts) for the
  exact callable contract.

Detailed pre-Solid mapping branches and DOM rendering mechanics were not
retained here. They duplicated logic that now belongs to Core or described
helpers that no longer exist. The remaining extraction boundary is summarized
in the [legacy save-to-semantic note](save-to-semantic.md).
