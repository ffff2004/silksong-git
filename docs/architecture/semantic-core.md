# Semantic Core Architecture

The Semantic Core turns Encoded Save bytes into stable, user-meaningful state
and changes. It owns save decoding, schema recognition, Mapping Data,
Semantic Snapshot creation, and Semantic Event generation. Its live public
contract is the package-root
[`@silksong-git/core` Interface](../../packages/core/src/index.ts); callers must
not import its internal readers or mapping helpers.

The small public Interface and caller-supplied Mapping Data follow
[ADR-0012](../adr/0012-core-semantic-module-interface.md). Exact callable and
data types remain in the package export rather than being duplicated here.

## Boundary

The Core is a deterministic transformation Module. Callers provide bytes,
decoded values, Mapping Data, and optional snapshot context; the Core returns
decoded, parsed, snapshot, or event values. It does not read files, select
commits, persist a Semantic Read Model, watch a save, serve requests, or render
a UI.

Consequently, the Core has no DOM, Git, SQLite, filesystem-watching, or HTTP
concerns. History persistence owns observation capture, rebuilds, and storage;
adapters and the Web UI use the package-root Interface and own their respective
I/O. Display Semantic Event Filters also remain outside Core: they affect
queries and presentation, not which Semantic Events the diff produces.

## Transformation Pipeline

The current pipeline has five explicit steps:

1. `decodeEncodedSave` decrypts and decodes Encoded Save bytes into an unknown
   Decoded Save value. Decode failures are reported separately from schema
   recognition failures, and the result carries the decoder Version Stamp.
2. `parseDecodedSave` validates the Decoded Save against a recognized Save
   Schema Version. The current parser recognizes one schema and rejects other
   successfully decoded shapes as unrecognized.
3. `getBuiltinMappingData` supplies the current built-in item catalogue, copied
   from the mapping used by the Web UI. A caller can instead supply fixture or
   alternative Mapping Data through the same public seam.
4. `createSemanticSnapshot` reads recognized fields according to that Mapping
   Data and creates the full Semantic Snapshot for that observation.
5. `diffSemanticSnapshots` compares two Semantic Snapshots and emits Semantic
   Events. It performs no persistence or display filtering.

The decoder/parser split is observable in the
[`decodeEncodedSave` behavior tests](../../packages/core/src/decode/decode-encoded-save.test.ts).
Snapshot and diff semantics are specified by their live
[`createSemanticSnapshot` tests](../../packages/core/src/snapshot/create-semantic-snapshot.test.ts)
and
[`diffSemanticSnapshots` tests](../../packages/core/src/diff/diff-semantic-snapshots.test.ts).

## Mapping Data and Semantic Snapshots

Mapping Data names recognizable items and describes how their state is derived
from a Decoded Save. The built-in data covers the `main`, `essentials`,
`bosses`, `mini-bosses`, `completion`, `wishes`, `journal`, and `scenes`
sections accepted by [ADR-0003](../adr/0003-semantic-snapshot-coverage.md).
The implementation hides field lookup, saved-data normalization, scene flag
handling, and item-type branching behind snapshot creation.

A Semantic Snapshot contains the full recognized item state, not merely the
items that changed. Each item has a semantic identity, status and value, plus
Source References for explaining which Decoded Save fields contributed to it.
The snapshot also contains the Save Summary Metrics `completionPercentage`,
`playTime`, `rosaries`, `shellShards`, and `permadeathMode`. These semantic
names deliberately hide raw field names such as the field currently mapped to
rosaries.

Current Source Reference values point to player data, saved-data entries, or
scene flags. Mapping identity is currently carried by the Semantic Snapshot
item and later Semantic Event metadata; there is not yet a separate
mapping-entry Source Reference variant.

## Semantic Events and Regressions

A Semantic Event is a user-meaningful transition between two Semantic
Snapshots, not a raw field diff, as established by
[ADR-0002](../adr/0002-item-level-semantic-events.md). Current diff behavior
emits:

- an item event when the status of an item present in both snapshots changes;
- an item value event for journal progress when its status is unchanged but its
  numeric value changes; and
- a summary-metric event whenever a Save Summary Metric changes.

Threshold and stage progress is represented by mapped item states, so crossing
multiple mapped thresholds can produce an event for each newly satisfied item.
The numeric rules and query-time filtering boundary are recorded in
[ADR-0014](../adr/0014-numeric-semantic-event-rules.md).

Every event retains the applicable Source References and the before/after
snapshot Version Stamps. A backwards item state or numeric value produces a
Regression Event: it remains a valid Semantic Event and is marked as a
regression rather than discarded or treated as an error. Restore, rollback,
and save replacement can all legitimately cause such transitions.

## Version Stamps

Version Stamps explain which interpretation produced an artifact, following
[ADR-0015](../adr/0015-version-stamps-for-decoding-and-semantic-mapping.md).
The current decoder result records its decoder version separately. A Semantic
Snapshot records its Save Schema Version and semantic-core version, plus an
optional Mapping Data version and optional game, platform, platform-build, and
Effective Config hash context. Semantic Events retain both input snapshots'
stamps.

At present, the parser supplies the recognized Save Schema Version, while the
optional game and platform provenance must already be present in a supplied
parsed value to reach a snapshot. The snapshot caller supplies the config hash.
The built-in Mapping Data supplies the current `web-current` version, while the
public Interface also permits caller-supplied Mapping Data without a version.
Persistence and stale-read-model detection belong to the Save History Module,
not Core.

## Unsupported and Unrecognized Inputs

An Encoded Save that cannot be decoded is a decode failure. A value that
decodes successfully but does not match the supported schema is an
unrecognized schema, so Core cannot create a Semantic Snapshot or Semantic
Events for it. The Save History Module's decision to preserve that Raw Save
Observation for a future rebuild is defined by
[ADR-0016](../adr/0016-commit-unrecognized-schema-observations.md); it is not a
Core persistence responsibility.

## Unresolved Future Mapping Work

The following are future design or implementation questions, not current Core
guarantees:

- selecting parsers and Mapping Data for more than the currently recognized
  Save Schema Version;
- deriving game and distribution provenance during parsing rather than
  receiving it from a caller;
- defining Mapping Data versioning and upgrade compatibility beyond the
  current built-in version string; and
- deciding whether Source References need a first-class pointer to a Mapping
  Data entry in addition to the current item identity and Decoded Save sources.

These questions must be resolved through ADRs or tracker work before this
document describes them as architecture. The documentation migration's
[classification ticket](https://github.com/ffff2004/silksong-git/issues/11)
owns disposition of unassigned questions from the previous design document.
