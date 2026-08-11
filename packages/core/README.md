# `@silksong-git/core`

Browser-safe semantic decoding, mapping, snapshots, and diffs for _Hollow
Knight: Silksong_ saves.

## Install

```sh
npm install @silksong-git/core
# or
pnpm add @silksong-git/core
```

Core requires Node.js 24 or newer. It is an ESM-only package for Node.js and
modern browser ESM bundlers. CommonJS and direct browser CDN usage are not
supported.

## Package-root API

The supported public API is exported from `@silksong-git/core`:

- `decodeEncodedSave` turns encoded save bytes into a decoded value.
- `parseDecodedSave` validates a decoded value against a recognized save
  schema.
- `getBuiltinMappingData` returns the complete Mapping Data shipped with Core.
- `createSemanticSnapshot` maps a parsed save into user-meaningful state.
- `diffSemanticSnapshots` returns meaningful transitions between snapshots.
- `DecodeEncodedSaveError` and `UnrecognizedSaveSchemaError` identify the two
  expected decoding and schema-recognition failures.
- Package-root TypeScript exports describe decoded saves, Mapping Data,
  snapshots, events, versions, and source references.

Non-root internal paths are implementation details and are not public API.

## Minimal workflow

```ts
import { readFile } from "node:fs/promises";
import {
  createSemanticSnapshot,
  decodeEncodedSave,
  diffSemanticSnapshots,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";

async function snapshot(path: string) {
  const bytes = await readFile(path);
  const decoded = decodeEncodedSave(bytes);
  const parsed = parseDecodedSave(decoded.decodedSave);

  return createSemanticSnapshot(parsed, getBuiltinMappingData());
}

const before = await snapshot("before.dat");
const after = await snapshot("after.dat");
const events = diffSemanticSnapshots(before, after);
```

`createSemanticSnapshot` always receives Mapping Data from its caller. Use
`getBuiltinMappingData()` for Silksong Git's full bundled tracker definitions,
or provide your own `MappingData` value for a specialized or test mapping.
Supplying custom Mapping Data does not make Core load URLs or other network
resources.

The fixed save key commonly known in the Silksong tooling community is
interoperability information used to decode compatible saves. It is not a
secret and does not provide confidentiality protection for a save file.

## Compatibility

Core `0.1.x` releases preserve backward compatibility. A breaking public API
change advances to the next `0.x` minor. Public removals are documented and
marked `@deprecated` before removal, then retained until the next Core minor.
An urgent security or correctness problem may require immediate removal.

See the
[Core changelog](https://github.com/ffff2004/silksong-git/blob/main/packages/core/CHANGELOG.md)
for release notes. Published release tags use `core-v<version>`.

## Credits and legal

Silksong Git is based on the
[silksong-tracker](https://github.com/th3r3dfox/silksong-tracker) project and
preserves the work of its contributors. That project was inspired by
[Hollow Knight Save Analyzer](https://reznormichael.github.io/hollow-knight-completion-check/).

This is an unofficial fan project. It is not affiliated with or endorsed by
Team Cherry and is not official game support. Game names, text, and related
intellectual property belong to their respective owners.

The package is distributed under the [MIT License](./LICENSE).
