# Expose a small semantic core interface

We decided that `packages/core` exposes a small deep Module interface: `decodeEncodedSave`, `parseDecodedSave`, `getBuiltinMappingData`, `createSemanticSnapshot`, and `diffSemanticSnapshots`. The core implementation may contain helpers for scene flag extraction, item value lookup, unlock normalization, and data table merging, but those helpers are not part of the external Interface because Web, CLI, and history callers should not need to understand raw save shapes or mapping internals.

`createSemanticSnapshot` accepts `MappingData` instead of loading it implicitly, so tests and callers can provide fixture or bundled mapping data through the same seam. This keeps the Interface testable through observable behavior while preserving depth behind it.
