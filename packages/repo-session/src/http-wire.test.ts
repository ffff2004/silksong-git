import { strict as assert } from "node:assert";
import test from "node:test";

import {
  historyQuerySchema,
  historyResultSchema,
  saveQuerySchema,
  searchQuerySchema,
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

test("wire response schemas accept additive fields without changing DTOs", () => {
  assert.deepEqual(
    historyResultSchema.parse({ events: [], futureField: true }),
    { events: [] },
  );
});
