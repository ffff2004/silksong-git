import { strict as assert } from "node:assert";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import {
  diffCommits,
  initSaveHistory,
  observeSave,
  queryHistory,
  rebuildSemanticReadModel,
  restoreEncodedSave,
  searchSemanticEvents,
} from "./index.ts";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "../../core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const unrecognizedEncodedSavePath = path.join(
  fixtureDirectory,
  "unrecognized-schema-save.dat",
);
const maskShard2CollectedEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-save.dat",
);
const maskShard2CollectedRosariesEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-rosaries-save.dat",
);

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "silksong-history-test-"),
  );

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

test("initSaveHistory creates a Save History Repository project config", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  const result = await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });

  assert.equal(result.repoPath, repoPath);
  assert.equal(
    result.configPath,
    path.join(repoPath, ".silksong-git/config.json"),
  );
  await assert.doesNotReject(async () => await stat(repoPath));
  const configJson = await readFile(result.configPath, "utf8");
  const config = JSON.parse(configJson) as { watchedSavePath?: unknown };

  assert.equal(config.watchedSavePath, minimalEncodedSavePath);
});

test("observeSave commits a recognized Raw Save Observation", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const observedAt = new Date("2026-06-30T12:00:00.000Z");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });

  const result = await observeSave({ repoPath, observedAt });

  assert.equal(result.status, "committed");
  assert.equal(result.observation.observedAt, observedAt.toISOString());
  assert.equal(result.observation.sourcePath, minimalEncodedSavePath);
  assert.match(result.observation.encodedSha256, /^[0-9a-f]{64}$/v);
  assert.match(result.observation.decodedSha256, /^[0-9a-f]{64}$/v);
  assert.equal(result.observation.decoderVersion, "silksong-save-decoder-v1");
  assert.equal(result.observation.schema.status, "recognized");
  assert.equal(result.observation.schema.saveSchemaVersion, "silksong-save-v1");
  assert.match(result.observation.commit.ref, /^[0-9a-f]{40}$/v);
  assert.match(result.observation.commit.shortRef, /^[0-9a-f]{7,12}$/v);
  assert.notEqual(result.observation.commit.committedAt, "");
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "save.dat")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "decoded-save.json")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "observation.json")),
  );
});

test("restoreEncodedSave writes the observed Encoded Save byte-for-byte", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const restorePath = path.join(tempDirectory, "restored-save.dat");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const observationResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observationResult.status, "committed");

  const restoreResult = await restoreEncodedSave({
    repoPath,
    commitRef: observationResult.observation.commit.ref,
    target: {
      kind: "path",
      path: restorePath,
    },
  });

  assert.equal(restoreResult.targetPath, restorePath);
  assert.equal(
    restoreResult.commit.ref,
    observationResult.observation.commit.ref,
  );
  assert.equal(
    restoreResult.writtenSha256,
    observationResult.observation.encodedSha256,
  );
  assert.deepEqual(
    await readFile(restorePath),
    await readFile(minimalEncodedSavePath),
  );
});

test("observeSave skips an unchanged Encoded Save", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const firstResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });
  const secondResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(firstResult.status, "committed");
  assert.equal(secondResult.status, "skipped");
  assert.equal(secondResult.reason, "unchanged");
  assert.equal(
    secondResult.encodedSha256,
    firstResult.observation.encodedSha256,
  );
});

test("observeSave reports decode failures as Watcher Errors without committing", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));
  await initSaveHistory({
    repoPath,
    watchedSavePath: invalidSavePath,
  });

  const result = await observeSave({ repoPath });

  assert.equal(result.status, "watcherError");
  assert.equal(result.error.reason, "decodeFailure");
  await assert.rejects(
    async () => await stat(path.join(repoPath, "observation.json")),
  );
});

test("observeSave commits an Unrecognized Schema Observation without semantic update", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const unrecognizedSavePath = path.join(
    tempDirectory,
    "unrecognized-save.dat",
  );
  const restorePath = path.join(tempDirectory, "restored-unrecognized.dat");

  await copyFile(unrecognizedEncodedSavePath, unrecognizedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath: unrecognizedSavePath,
  });

  const result = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(result.status, "committed");
  assert.equal(result.observation.schema.status, "unrecognized");
  assert.notEqual(result.observation.schema.reason, "");
  assert.equal(result.semanticUpdate.status, "notAvailable");
  assert.equal(result.semanticUpdate.reason, "unrecognizedSchema");
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "save.dat")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "decoded-save.json")),
  );
  await assert.doesNotReject(
    async () => await stat(path.join(repoPath, "observation.json")),
  );

  const restoreResult = await restoreEncodedSave({
    repoPath,
    commitRef: result.observation.commit.ref,
    target: {
      kind: "path",
      path: restorePath,
    },
  });

  assert.equal(restoreResult.writtenSha256, result.observation.encodedSha256);
  assert.deepEqual(
    await readFile(restorePath),
    await readFile(unrecognizedSavePath),
  );
});

test("restoreEncodedSave refuses to overwrite an existing target implicitly", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const restorePath = path.join(tempDirectory, "existing-save.dat");
  const existingBytes = new Uint8Array([9, 8, 7, 6]);

  await writeFile(restorePath, existingBytes);
  await initSaveHistory({
    repoPath,
    watchedSavePath: minimalEncodedSavePath,
  });
  const observationResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  assert.equal(observationResult.status, "committed");

  await assert.rejects(
    async () =>
      await restoreEncodedSave({
        repoPath,
        commitRef: observationResult.observation.commit.ref,
        target: {
          kind: "path",
          path: restorePath,
        },
      }),
  );
  assert.deepEqual(await readFile(restorePath), Buffer.from(existingBytes));
});

test("rebuildSemanticReadModel rebuilds recognized Semantic Events for queryHistory", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  const beforeResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  const afterResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(beforeResult.status, "committed");
  assert.equal(afterResult.status, "committed");

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const history = await queryHistory({ repoPath });

  assert.equal(rebuildResult.observationCount, 2);
  assert.equal(rebuildResult.recognizedObservationCount, 2);
  assert.equal(rebuildResult.unrecognizedObservationCount, 0);
  assert.equal(rebuildResult.snapshotCount, 2);
  assert.equal(rebuildResult.eventCount, 1);
  assert.equal(history.events.length, 1);

  const [historicalEvent] = history.events;

  assert.ok(historicalEvent !== undefined);
  assert.equal(historicalEvent.commit.ref, afterResult.observation.commit.ref);
  assert.equal(
    historicalEvent.previousCommit?.ref,
    beforeResult.observation.commit.ref,
  );
  assert.equal(
    historicalEvent.observation.commit.ref,
    afterResult.observation.commit.ref,
  );
  assert.equal(historicalEvent.event.kind, "item");
  assert.equal(historicalEvent.event.eventType, "itemStatusChanged");
  assert.equal(historicalEvent.event.item.id, "mask-shard-2");
  assert.equal(historicalEvent.event.after.status, "done");
  assert.deepEqual(historicalEvent.visibility, {
    defaultVisible: true,
    filterReasons: [],
  });
});

test("rebuildSemanticReadModel preserves Unrecognized Schema Observations without Semantic Events", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  const recognizedResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(unrecognizedEncodedSavePath, watchedSavePath);
  const unrecognizedResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(recognizedResult.status, "committed");
  assert.equal(unrecognizedResult.status, "committed");

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const history = await queryHistory({
    repoPath,
    includeRawObservations: true,
  });

  assert.equal(rebuildResult.observationCount, 2);
  assert.equal(rebuildResult.recognizedObservationCount, 1);
  assert.equal(rebuildResult.unrecognizedObservationCount, 1);
  assert.equal(rebuildResult.snapshotCount, 1);
  assert.equal(rebuildResult.eventCount, 0);
  assert.equal(history.events.length, 0);
  assert.ok(history.rawObservations !== undefined);
  assert.equal(history.rawObservations.length, 2);
  const [recognizedObservation, unrecognizedObservation] =
    history.rawObservations;

  assert.ok(recognizedObservation !== undefined);
  assert.ok(unrecognizedObservation !== undefined);
  assert.equal(recognizedObservation.schema.status, "recognized");
  assert.equal(unrecognizedObservation.schema.status, "unrecognized");
  assert.equal(
    unrecognizedObservation.commit.ref,
    unrecognizedResult.observation.commit.ref,
  );
});

test("queryHistory paginates events and returns raw observations only when requested", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  const firstObservation = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  const secondObservation = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  await copyFile(maskShard2CollectedRosariesEncodedSavePath, watchedSavePath);
  const thirdObservation = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  assert.equal(firstObservation.status, "committed");
  assert.equal(secondObservation.status, "committed");
  assert.equal(thirdObservation.status, "committed");

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const firstPage = await queryHistory({
    repoPath,
    includeFiltered: true,
    limit: 1,
  });

  assert.equal(rebuildResult.eventCount, 2);
  assert.equal(firstPage.events.length, 1);
  assert.equal("rawObservations" in firstPage, false);
  assert.notEqual(firstPage.nextCursor, undefined);

  const secondPage = await queryHistory({
    repoPath,
    includeFiltered: true,
    limit: 1,
    cursor: firstPage.nextCursor,
  });

  assert.equal(secondPage.events.length, 1);
  assert.notEqual(secondPage.events[0]?.id, firstPage.events[0]?.id);
  assert.equal(secondPage.nextCursor, undefined);

  const withRawObservations = await queryHistory({
    repoPath,
    includeFiltered: true,
    includeRawObservations: true,
    limit: 1,
  });

  assert.ok(withRawObservations.rawObservations !== undefined);
  assert.equal(withRawObservations.rawObservations.length, 3);
  assert.equal(
    withRawObservations.rawObservations[0]?.commit.ref,
    firstObservation.observation.commit.ref,
  );
  assert.equal(
    withRawObservations.rawObservations[2]?.commit.ref,
    thirdObservation.observation.commit.ref,
  );
});

test("diffCommits returns Semantic Snapshots and Historical Semantic Events", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  const beforeResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  const afterResult = await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  assert.equal(beforeResult.status, "committed");
  assert.equal(afterResult.status, "committed");

  await rebuildSemanticReadModel({ repoPath });
  const diff = await diffCommits({
    repoPath,
    fromRef: beforeResult.observation.commit.ref,
    toRef: afterResult.observation.commit.ref,
  });

  assert.equal(diff.from.ref, beforeResult.observation.commit.ref);
  assert.equal(diff.to.ref, afterResult.observation.commit.ref);
  assert.equal(diff.before.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(diff.after.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(diff.events.length, 1);
  const [event] = diff.events;

  assert.ok(event !== undefined);
  assert.equal(event.commit.ref, afterResult.observation.commit.ref);
  assert.equal(event.previousCommit?.ref, beforeResult.observation.commit.ref);
  assert.equal(event.event.kind, "item");
});

test("searchSemanticEvents finds events by structured fields", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  await copyFile(maskShard2CollectedRosariesEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  await rebuildSemanticReadModel({ repoPath });

  const itemSearch = await searchSemanticEvents({
    repoPath,
    query: {
      itemId: "mask-shard-2",
      statusTo: "done",
    },
  });
  const summarySearch = await searchSemanticEvents({
    repoPath,
    query: {
      eventType: "summaryMetricChanged",
    },
    includeFiltered: true,
  });

  assert.equal(itemSearch.events.length, 1);
  const [itemEvent] = itemSearch.events;

  assert.ok(itemEvent !== undefined);
  assert.equal(itemEvent.event.kind, "item");
  assert.equal(summarySearch.events.length, 1);
  const [summaryEvent] = summarySearch.events;

  assert.ok(summaryEvent !== undefined);
  assert.equal(summaryEvent.event.kind, "summaryMetric");
  assert.equal(summaryEvent.event.direction, "progression");
});

test("searchSemanticEvents finds events by free text", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  await copyFile(maskShard2CollectedRosariesEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  await rebuildSemanticReadModel({ repoPath });

  const maskShardSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "Mask Shard",
    },
  });
  const rosariesSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "rosaries",
    },
    includeFiltered: true,
  });
  const unrelatedSearch = await searchSemanticEvents({
    repoPath,
    query: {
      text: "definitely not present",
    },
  });

  assert.equal(maskShardSearch.events.length, 1);
  assert.equal(maskShardSearch.events[0]?.event.kind, "item");
  assert.equal(rosariesSearch.events.length, 1);
  assert.equal(rosariesSearch.events[0]?.event.kind, "summaryMetric");
  assert.equal(unrelatedSearch.events.length, 0);
});

test("queryHistory applies Display Semantic Event Filters at query time", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "watched-save.dat");

  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({
    repoPath,
    watchedSavePath,
  });
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:00:00.000Z"),
  });

  await copyFile(maskShard2CollectedEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:01:00.000Z"),
  });

  await copyFile(maskShard2CollectedRosariesEncodedSavePath, watchedSavePath);
  await observeSave({
    repoPath,
    observedAt: new Date("2026-06-30T12:02:00.000Z"),
  });

  const rebuildResult = await rebuildSemanticReadModel({ repoPath });
  const defaultHistory = await queryHistory({ repoPath });
  const completeHistory = await queryHistory({
    repoPath,
    includeFiltered: true,
  });

  assert.equal(rebuildResult.eventCount, 2);
  assert.equal(defaultHistory.events.length, 1);
  const [defaultEvent] = defaultHistory.events;

  assert.ok(defaultEvent !== undefined);
  assert.equal(defaultEvent.event.kind, "item");
  assert.equal(defaultEvent.visibility.defaultVisible, true);
  assert.equal(completeHistory.events.length, 2);

  const hiddenSummaryEvent = completeHistory.events.find(
    (event) => event.event.kind === "summaryMetric",
  );

  assert.ok(hiddenSummaryEvent !== undefined);
  assert.equal(hiddenSummaryEvent.visibility.defaultVisible, false);
  assert.deepEqual(hiddenSummaryEvent.visibility.filterReasons, [
    "summaryMetric:rosaries",
  ]);
});
