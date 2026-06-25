# Record version stamps for decoding and semantic mapping

We decided to record Version Stamps for decoder output and semantic interpretation. Raw observations record `decoderVersion` with `decoded-save.json`; Semantic Snapshots and Semantic Events record `saveSchemaVersion`, optional `gameVersion`, optional `platform`, optional `platformBuildId`, `mappingDataVersion`, `semanticCoreVersion`, and `configHash` in the SQLite Semantic Read Model.

This lets rebuilds detect stale read-model data and lets users understand why the same raw observation may produce different semantic events after mapping data, semantic rules, or Display Semantic Event Filters change.

`saveSchemaVersion` is the main branch point for parser and mapping behavior when game updates change save structure or flag semantics. `gameVersion` is the in-game displayed version and is recorded when available from the save or provided by the user, but it may be unavailable and should not be the only way to select mapping behavior. `platformBuildId` records platform-specific distribution provenance, such as a Steam build ID, and must not replace `gameVersion` or `saveSchemaVersion`.
