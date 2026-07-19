# Pre-Solid Save-to-Semantic Mapping

> **Legacy reference:** this page records why semantic behavior was extracted
> from the pre-Solid Web application. It does not define current mapping rules.

Before the Semantic Core existed, the Web application spread save
interpretation across upload handlers, a decoder and parser, a recursively
built scene-flag index, bundled JSON catalogues, type-specific value lookup,
completion normalization, and DOM rendering. Raw save state and derived indexes
were stored in module-level variables. Consequently, reusable semantic behavior
could not be called independently of the Web runtime and rendering lifecycle.

The extraction preserved two important seams:

- bundled item definitions combine user-facing identity and metadata with the
  source description needed to interpret a Decoded Save; and
- raw shapes are not uniform: direct player fields, named `savedData` entries,
  scene flags, journal counts, visited-scene sets, thresholds, and combined
  conditions require normalization before the UI can render a user-meaningful
  state.

Those facts explain the migration, but their exact branches are deliberately
not copied here. Current decoding, schema recognition, Mapping Data,
normalization, Semantic Snapshot state, summary metrics, Source References, and
Semantic Event behavior are owned by the
[Semantic Core architecture](../../architecture/semantic-core.md), the public
[`@silksong-git/core` Interface](../../../packages/core/src/index.ts), and its
linked behavior tests.

The current Solid Web application consumes the resulting Semantic Snapshot
rather than reimplementing raw-save lookup rules. See the
[Web architecture](../../architecture/web.md) for its Static and Local History
flows. When investigating an old commit, historical helper names and mapping
branches may still explain why an item catalogue or compatibility test exists;
they must not be treated as a second semantic specification.
