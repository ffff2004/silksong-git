import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { isObject } from "complete-common";

import {
  createSemanticSnapshot,
  decodeEncodedSave,
  DecodeEncodedSaveError,
  getBuiltinMappingData,
  parseDecodedSave,
  UnrecognizedSaveSchemaError,
} from "../index.ts";

const fixtureDirectory = path.join(import.meta.dirname, "fixtures");

test("decodeEncodedSave decodes an encoded Silksong save fixture", async () => {
  const encodedSave = await readFile(
    path.join(fixtureDirectory, "minimal-valid-save.dat"),
  );

  const decoded = decodeEncodedSave(encodedSave);

  assert.equal(decoded.version.decoderVersion, "silksong-save-decoder-v1");
  assert.ok(isObject(decoded.decodedSave));
  assert.ok("playerData" in decoded.decodedSave);
});

test("parseDecodedSave validates a decoded Silksong save fixture", async () => {
  const encodedSave = await readFile(
    path.join(fixtureDirectory, "minimal-valid-save.dat"),
  );

  const decoded = decodeEncodedSave(encodedSave);
  const parsedSave = parseDecodedSave(decoded.decodedSave);

  assert.equal(parsedSave.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(parsedSave.decodedSave.playerData["completionPercentage"], 39);
  assert.equal(parsedSave.decodedSave.playerData["playTime"], 87_137.12);
  assert.equal(parsedSave.decodedSave.playerData["geo"], 731);
  assert.equal(parsedSave.decodedSave.playerData["ShellShards"], 76);
});

test("parseDecodedSave validates a decoded JSON-style save fixture", async () => {
  const decodedSaveJson = await readFile(
    path.join(fixtureDirectory, "minimal-valid-save.decoded.json"),
    "utf8",
  );
  const decodedSave: unknown = JSON.parse(decodedSaveJson);

  const parsedSave = parseDecodedSave(decodedSave);

  assert.equal(parsedSave.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(parsedSave.decodedSave.playerData["completionPercentage"], 39);
  assert.equal(parsedSave.decodedSave.playerData["geo"], 731);
});

test("decoded saves pass schema versions into semantic snapshots through core", async () => {
  const encodedSave = await readFile(
    path.join(fixtureDirectory, "minimal-valid-save.dat"),
  );

  const decoded = decodeEncodedSave(encodedSave);
  const parsedSave = parseDecodedSave(decoded.decodedSave);
  const snapshot = createSemanticSnapshot(parsedSave, getBuiltinMappingData());

  assert.equal(snapshot.summary.completionPercentage, 39);
  assert.equal(snapshot.summary.playTime, 87_137.12);
  assert.equal(snapshot.summary.rosaries, 731);
  assert.equal(snapshot.summary.shellShards, 76);
  assert.equal(snapshot.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(snapshot.version.semanticCoreVersion, "core-semantic-v1");
});

test("decodeEncodedSave reports invalid encoded bytes as a decode failure", () => {
  assert.throws(
    () => decodeEncodedSave(new Uint8Array([1, 2, 3, 4])),
    DecodeEncodedSaveError,
  );
});

test("parseDecodedSave reports unsupported decoded shapes as unrecognized schema", () => {
  assert.throws(
    () => parseDecodedSave({ playerData: { completionPercentage: 39 } }),
    UnrecognizedSaveSchemaError,
  );
});
