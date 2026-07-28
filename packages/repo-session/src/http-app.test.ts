import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

import { initSaveHistory, observeSave } from "@silksong-git/history";

import { createLocalHttpOpenApiDocument } from "./http-contract.ts";
import type { RepoSessionEvent } from "./index.ts";
import { openRepoSession } from "./index.ts";

const fixtureDirectory = path.join(
  import.meta.dirname,
  "../../core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const maskShardEncodedSavePath = path.join(
  fixtureDirectory,
  "mask-shard-2-collected-save.dat",
);

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function startLocalHttpSession(
  t: TestContext,
  repoPath: string,
  events?: RepoSessionEvent[],
) {
  const session = await openRepoSession({
    repoPath,
    ...(events !== undefined && {
      onEvent: (event) => {
        events.push(event);
      },
    }),
    runtime: {
      fileStabilityProbe: {
        waitForStableFile: async () => undefined,
      },
      watchEventSource: {
        start: () => ({ stop: () => undefined }),
      },
    },
  });
  await session.startWatching();
  const { http } = session;

  t.after(async () => {
    await session.stop();
  });

  return {
    request: async (requestPath: string, init?: RequestInit) =>
      await fetch(new URL(requestPath, http.endpoint), init),
    token: http.token,
  };
}

interface OpenApiDocumentProbe {
  readonly openapi: string;
  readonly security: ReadonlyArray<Record<string, readonly string[]>>;
  readonly paths: Record<
    string,
    {
      readonly get: {
        readonly responses: Record<
          string,
          {
            readonly content: Record<
              string,
              {
                readonly schema: {
                  readonly type?: string;
                  readonly $ref?: string;
                };
              }
            >;
          }
        >;
      };
    }
  >;
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly schemas: Record<string, OpenApiSchemaProbe>;
  };
}

interface OpenApiSchemaProbe {
  readonly enum?: readonly unknown[];
  readonly properties?: Record<string, OpenApiSchemaProbe>;
}

test("OpenAPI describes the complete authenticated Local History API", () => {
  const document =
    createLocalHttpOpenApiDocument() as unknown as OpenApiDocumentProbe;

  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths).toSorted(), [
    "/api/v1/checkpoints",
    "/api/v1/diff",
    "/api/v1/export",
    "/api/v1/history",
    "/api/v1/observations",
    "/api/v1/restores/in-place",
    "/api/v1/save",
    "/api/v1/search",
    "/api/v1/watcher",
  ]);
  assert.deepEqual(document.components.securitySchemes["bearerAuth"], {
    type: "http",
    scheme: "bearer",
  });
  assert.deepEqual(document.security, [{ bearerAuth: [] }]);
  const historicalEventSchema =
    document.components.schemas["HistoricalSemanticEvent"];
  const rawObservationEntrySchema =
    document.components.schemas["RawObservationHistoryEntry"];
  const rawObservationResultSchema =
    document.components.schemas["RawObservationHistoryResult"];

  assert.ok(historicalEventSchema?.properties?.["snapshotSummary"]);
  assert.ok(rawObservationEntrySchema?.properties?.["snapshotSummary"]);
  assert.ok(rawObservationResultSchema?.properties?.["entries"]);
  const errorObjectSchema =
    document.components.schemas["LocalHttpError"]?.properties?.["error"];
  const errorCodeSchema = errorObjectSchema?.properties?.["code"];

  assert.ok(errorObjectSchema);
  assert.ok(errorCodeSchema);
  assert.equal(errorCodeSchema.enum?.includes("restore_conflict"), true);
  assert.equal(
    document.paths["/api/v1/export"]?.get.responses["200"]?.content[
      "application/octet-stream"
    ]?.schema.type,
    "string",
  );
});

test("authenticated watcher reports the current watcher status", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await initSaveHistory({ repoPath, watchedSavePath });

  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const unauthorized = await http.request("/api/v1/watcher");
  const wrongToken = await http.request("/api/v1/watcher", {
    headers: { Authorization: "Bearer wrong" },
  });
  const response = await http.request("/api/v1/watcher", {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), {
    error: { code: "unauthorized", message: "Authentication required." },
  });
  assert.equal(wrongToken.status, 401);
  assert.deepEqual(await wrongToken.json(), {
    error: { code: "unauthorized", message: "Authentication required." },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const watcher = await readJson<{
    readonly activity: string;
    readonly capturePolicy: unknown;
    readonly repoPath: string;
    readonly status: string;
    readonly watchedSavePath: string;
  }>(response);

  assert.equal(watcher.status, "running");
  assert.equal(watcher.activity, "idle");
  assert.equal(watcher.repoPath, repoPath);
  assert.equal(watcher.watchedSavePath, watchedSavePath);
  assert.deepEqual(watcher.capturePolicy, {
    debounceWriteMs: 500,
    minCommitIntervalMs: 0,
  });
});

test("CORS preflight is public while actual browser requests remain authenticated", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await initSaveHistory({ repoPath, watchedSavePath });
  const http = await startLocalHttpSession(t, repoPath);
  const preflight = await http.request("/api/v1/watcher", {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  const actual = await http.request("/api/v1/watcher", {
    headers: { Origin: "https://example.test" },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(
    preflight.headers.get("Access-Control-Allow-Headers") ?? "",
    /Authorization/iv,
  );
  assert.equal(
    preflight.headers.has("Access-Control-Allow-Private-Network"),
    false,
  );
  assert.equal(actual.status, 401);
  assert.equal(actual.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(actual.headers.has("Access-Control-Allow-Credentials"), false);
});

test("save and history GET routes expose public history behavior recent-first", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  const before = await observeSave({
    repoPath,
    observedAt: new Date("2026-07-12T00:00:00.000Z"),
  });
  await copyFile(maskShardEncodedSavePath, watchedSavePath);
  const after = await observeSave({
    repoPath,
    observedAt: new Date("2026-07-12T00:01:00.000Z"),
  });

  assert.equal(before.status, "committed");
  assert.equal(after.status, "committed");

  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const headers = { Authorization: `Bearer ${token}` };
  const save = await http.request("/api/v1/save?selector=latest", { headers });
  const history = await http.request("/api/v1/history?includeFiltered=true", {
    headers,
  });
  const observations = await http.request("/api/v1/observations", { headers });
  const diff = await http.request(
    `/api/v1/diff?from=${before.observation.commit.ref}&to=${after.observation.commit.ref}`,
    { headers },
  );
  const search = await http.request("/api/v1/search?itemId=mask-shard-2", {
    headers,
  });

  assert.equal(save.status, 200);
  const saveBody = await readJson<{ observation: { commit: { ref: string } } }>(
    save,
  );
  const historyBody = await readJson<{
    events: ReadonlyArray<{ snapshotSummary: { rosaries?: number } }>;
  }>(history);
  const observationBody = await readJson<{
    entries: ReadonlyArray<{
      observation: { commit: { ref: string } };
      snapshotSummary: { rosaries?: number } | null;
    }>;
  }>(observations);
  const diffBody = await readJson<{
    events: ReadonlyArray<{ snapshotSummary: { rosaries?: number } }>;
  }>(diff);
  const searchBody = await readJson<{
    events: ReadonlyArray<{ snapshotSummary: { rosaries?: number } }>;
  }>(search);

  assert.equal(saveBody.observation.commit.ref, after.observation.commit.ref);
  assert.equal(history.status, 200);
  assert.equal(historyBody.events.length, 1);
  assert.equal(historyBody.events[0]?.snapshotSummary.rosaries, 731);
  assert.equal(observations.status, 200);
  assert.equal(
    observationBody.entries[0]?.observation.commit.ref,
    after.observation.commit.ref,
  );
  const [observationEntry] = observationBody.entries;

  assert.ok(observationEntry.snapshotSummary !== null);
  assert.equal(observationEntry.snapshotSummary.rosaries, 731);
  assert.equal(diff.status, 200);
  assert.equal(diffBody.events.length, 1);
  assert.equal(diffBody.events[0]?.snapshotSummary.rosaries, 731);
  assert.equal(search.status, 200);
  assert.equal(searchBody.events.length, 1);
  assert.equal(searchBody.events[0]?.snapshotSummary.rosaries, 731);
});

test("checkpoint validates bounded strict JSON and preserves observation semantics", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  await observeSave({ repoPath });
  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const baseHeaders = { Authorization: `Bearer ${token}` };
  const unsupported = await http.request("/api/v1/checkpoints", {
    method: "POST",
    headers: baseHeaders,
    body: "{}",
  });
  const invalid = await http.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ unexpected: true }),
  });
  const unchanged = await http.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  const committed = await http.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ allowUnchanged: true, message: "before boss" }),
  });

  assert.equal(unsupported.status, 415);
  const unsupportedBody = await readJson<{ error: { code: string } }>(
    unsupported,
  );
  const unchangedBody = await readJson<{ status: string }>(unchanged);
  const committedBody = await readJson<{ status: string }>(committed);

  assert.equal(unsupportedBody.error.code, "unsupported_media_type");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: { code: "invalid_request", message: "Invalid request." },
  });
  assert.equal(unchangedBody.status, "skipped");
  assert.equal(committedBody.status, "committed");
});

test("HTTP input failures use bounded stable errors without leaking values", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  await observeSave({ repoPath });
  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const authorization = { Authorization: `Bearer ${token}` };
  const invalidBoolean = await http.request(
    "/api/v1/history?includeFiltered=yes",
    { headers: authorization },
  );
  const invalidLimit = await http.request("/api/v1/history?limit=1001", {
    headers: authorization,
  });
  const invalidCursor = await http.request(
    "/api/v1/history?cursor=not-a-cursor",
    {
      headers: authorization,
    },
  );
  const method = await http.request("/api/v1/watcher", {
    method: "POST",
    headers: authorization,
  });
  const route = await http.request("/api/v1/not-real", {
    headers: authorization,
  });
  const oversized = await http.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "x".repeat(17 * 1024) }),
  });

  for (const response of [invalidBoolean, invalidLimit, invalidCursor]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { code: "invalid_request", message: "Invalid request." },
    });
  }
  assert.equal(method.status, 405);
  assert.equal(route.status, 404);
  assert.equal(oversized.status, 413);
  const oversizedText = await oversized.text();

  assert.equal(oversizedText.includes("x".repeat(100)), false);
});

test("HTTP emits sanitized request events for 5xx failures but not 4xx responses", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await initSaveHistory({ repoPath, watchedSavePath });
  const events: RepoSessionEvent[] = [];
  const http = await startLocalHttpSession(t, repoPath, events);
  const { token } = http;
  const authorization = { Authorization: `Bearer ${token}` };
  const invalid = await http.request("/api/v1/history?limit=0", {
    headers: authorization,
  });
  const unavailable = await http.request("/api/v1/history", {
    headers: authorization,
  });

  assert.equal(invalid.status, 400);
  assert.equal(unavailable.status, 503);
  const requestErrors = events.flatMap((event) =>
    event.type === "httpRequestError" ? [event.error] : [],
  );

  assert.deepEqual(requestErrors, [
    {
      method: "GET",
      path: "/api/v1/history",
      status: 503,
      code: "read_model_unavailable",
      message: "Semantic Read Model is unavailable.",
    },
  ]);
});

test("export returns exact Encoded Save bytes and safe immutable headers", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user slot.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  const observed = await observeSave({ repoPath });

  assert.equal(observed.status, "committed");

  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const response = await http.request("/api/v1/export?commit=HEAD~0", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const expectedBytes = await readFile(minimalEncodedSavePath);

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expectedBytes);
  assert.equal(
    response.headers.get("Content-Type"),
    "application/octet-stream",
  );
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(
    response.headers.get("ETag"),
    `"sha256-${observed.observation.encodedSha256}"`,
  );
  assert.match(
    response.headers.get("Content-Disposition") ?? "",
    new RegExp(
      String.raw`user-slot\.${observed.observation.commit.shortRef}\.dat`,
      "v",
    ),
  );
  assert.equal(
    response.headers.get("Content-Disposition")?.includes(tempDirectory),
    false,
  );
});

test("in-place restore requires and enforces the confirmed current-save hash", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  const observed = await observeSave({ repoPath });

  assert.equal(observed.status, "committed");
  await copyFile(maskShardEncodedSavePath, watchedSavePath);
  const currentHash = createHash("sha256")
    .update(await readFile(watchedSavePath))
    .digest("hex");
  const http = await startLocalHttpSession(t, repoPath);
  const { token } = http;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const conflict = await http.request("/api/v1/restores/in-place", {
    method: "POST",
    headers,
    body: JSON.stringify({
      commitRef: observed.observation.commit.ref,
      confirmation: "restore-watched-save",
      expectedCurrent: { status: "missing" },
    }),
  });
  const restored = await http.request("/api/v1/restores/in-place", {
    method: "POST",
    headers,
    body: JSON.stringify({
      commitRef: observed.observation.commit.ref,
      confirmation: "restore-watched-save",
      expectedCurrent: { status: "present", encodedSha256: currentHash },
    }),
  });

  assert.equal(conflict.status, 409);
  const conflictBody = await readJson<{ error: { code: string } }>(conflict);

  assert.equal(conflictBody.error.code, "restore_conflict");
  assert.equal(restored.status, 200);
  const restoredBytes = await readFile(watchedSavePath);
  const expectedBytes = await readFile(minimalEncodedSavePath);

  assert.deepEqual(restoredBytes, expectedBytes);
});
