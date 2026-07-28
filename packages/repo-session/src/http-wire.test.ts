import { strict as assert } from "node:assert";
import test from "node:test";

import {
  historyQuerySchema,
  historyResultSchema,
  saveQuerySchema,
  searchQuerySchema,
  watcherStatusSchema,
} from "./http-wire.ts";

test("wire request schemas preserve defaults and strict validation", () => {
  assert.deepEqual(historyQuerySchema.parse({}), {
    includeFiltered: false,
    limit: 100,
    order: "desc",
  });
  assert.equal(
    saveQuerySchema.safeParse({ selector: "latest", unexpected: true }).success,
    false,
  );
  assert.equal(searchQuerySchema.safeParse({}).success, false);
});

test("watcher status does not expose active-only fields on inactive and transitional readers", () => {
  assert.deepEqual(
    watcherStatusSchema.parse({
      status: "inactive",
      observationRevision: 2,
      repoPath: "/tmp/history-repo",
    }),
    {
      status: "inactive",
      observationRevision: 2,
      repoPath: "/tmp/history-repo",
    },
  );
  assert.deepEqual(
    watcherStatusSchema.parse({
      status: "starting",
      activity: "idle",
      observationRevision: 2,
      repoPath: "/tmp/history-repo",
    }),
    {
      status: "starting",
      observationRevision: 2,
      repoPath: "/tmp/history-repo",
    },
  );
});

test("wire response schemas accept additive fields without changing DTOs", () => {
  assert.deepEqual(
    historyResultSchema.parse({ events: [], futureField: true }),
    { events: [] },
  );
});
