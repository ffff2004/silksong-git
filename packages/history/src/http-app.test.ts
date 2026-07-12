import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createLocalHttpApp,
  createLocalHttpOpenApiDocument,
  initSaveHistory,
  observeSave,
} from "./index.ts";

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
    "/api/v1/meta",
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
  assert.equal(
    document.paths["/api/v1/meta"]?.get.responses["200"]?.content[
      "application/json"
    ]?.schema.$ref,
    "#/components/schemas/LocalHttpMeta",
  );
  assert.ok(document.components.schemas["HistoricalSemanticEvent"]);
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

test("authenticated meta reports the versioned Local History API contract", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");
  const token = "a".repeat(43);

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await initSaveHistory({ repoPath, watchedSavePath });

  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 0,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const unauthorized = await app.request("/api/v1/meta");
  const wrongToken = await app.request("/api/v1/meta", {
    headers: { Authorization: "Bearer wrong" },
  });
  const response = await app.request("/api/v1/meta", {
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
  assert.deepEqual(await response.json(), {
    api: {
      name: "silksong-git-local-history",
      version: { major: 1, minor: 0 },
    },
    repoPath,
    watchedSavePath,
    capabilities: [
      "watcherStatus",
      "saveState",
      "history",
      "rawObservations",
      "diff",
      "search",
      "checkpoint",
      "exportEncodedSave",
      "restoreInPlace",
    ],
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
  const app = createLocalHttpApp({
    repoPath,
    token: "secret",
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 0,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const preflight = await app.request("/api/v1/meta", {
    method: "OPTIONS",
    headers: {
      Origin: "https://example.test",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  const actual = await app.request("/api/v1/meta", {
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
  const token = "secret";

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

  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 2,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const headers = { Authorization: `Bearer ${token}` };
  const save = await app.request("/api/v1/save?selector=latest", { headers });
  const history = await app.request("/api/v1/history?includeFiltered=true", {
    headers,
  });
  const observations = await app.request("/api/v1/observations", { headers });
  const diff = await app.request(
    `/api/v1/diff?from=${before.observation.commit.ref}&to=${after.observation.commit.ref}`,
    { headers },
  );
  const search = await app.request("/api/v1/search?itemId=mask-shard-2", {
    headers,
  });

  assert.equal(save.status, 200);
  const saveBody = await readJson<{ observation: { commit: { ref: string } } }>(
    save,
  );
  const historyBody = await readJson<{ events: readonly unknown[] }>(history);
  const observationBody = await readJson<{
    observations: ReadonlyArray<{ commit: { ref: string } }>;
  }>(observations);
  const diffBody = await readJson<{ events: readonly unknown[] }>(diff);
  const searchBody = await readJson<{ events: readonly unknown[] }>(search);

  assert.equal(saveBody.observation.commit.ref, after.observation.commit.ref);
  assert.equal(history.status, 200);
  assert.equal(historyBody.events.length, 1);
  assert.equal(observations.status, 200);
  assert.equal(
    observationBody.observations[0]?.commit.ref,
    after.observation.commit.ref,
  );
  assert.equal(diff.status, 200);
  assert.equal(diffBody.events.length, 1);
  assert.equal(search.status, 200);
  assert.equal(searchBody.events.length, 1);
});

test("checkpoint validates bounded strict JSON and preserves observation semantics", async (t) => {
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "silksong-http-test-"),
  );
  const repoPath = path.join(tempDirectory, "history-repo");
  const watchedSavePath = path.join(tempDirectory, "user1.dat");
  const token = "secret";

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  await observeSave({ repoPath });
  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 1,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const baseHeaders = { Authorization: `Bearer ${token}` };
  const unsupported = await app.request("/api/v1/checkpoints", {
    method: "POST",
    headers: baseHeaders,
    body: "{}",
  });
  const invalid = await app.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ unexpected: true }),
  });
  const unchanged = await app.request("/api/v1/checkpoints", {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: "{}",
  });
  const committed = await app.request("/api/v1/checkpoints", {
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
  const token = "secret";

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  await observeSave({ repoPath });
  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 1,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const authorization = { Authorization: `Bearer ${token}` };
  const invalidBoolean = await app.request(
    "/api/v1/history?includeFiltered=yes",
    { headers: authorization },
  );
  const invalidLimit = await app.request("/api/v1/history?limit=1001", {
    headers: authorization,
  });
  const invalidCursor = await app.request(
    "/api/v1/history?cursor=not-a-cursor",
    {
      headers: authorization,
    },
  );
  const method = await app.request("/api/v1/meta", {
    method: "POST",
    headers: authorization,
  });
  const route = await app.request("/api/v1/not-real", {
    headers: authorization,
  });
  const oversized = await app.request("/api/v1/checkpoints", {
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
  const token = "secret";
  const requestErrors: Array<{
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly code: string;
    readonly message: string;
  }> = [];

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await initSaveHistory({ repoPath, watchedSavePath });
  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 0,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
    onRequestError: (error) => {
      requestErrors.push(error);
    },
  });
  const authorization = { Authorization: `Bearer ${token}` };
  const invalid = await app.request("/api/v1/history?limit=0", {
    headers: authorization,
  });
  const unavailable = await app.request("/api/v1/history", {
    headers: authorization,
  });

  assert.equal(invalid.status, 400);
  assert.equal(unavailable.status, 503);
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
  const token = "secret";

  t.after(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  await copyFile(minimalEncodedSavePath, watchedSavePath);
  await initSaveHistory({ repoPath, watchedSavePath });
  const observed = await observeSave({ repoPath });

  assert.equal(observed.status, "committed");

  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 1,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const response = await app.request("/api/v1/export?commit=HEAD~0", {
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
  const token = "secret";

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
  const app = createLocalHttpApp({
    repoPath,
    token,
    getWatcherStatus: () => ({
      status: "running",
      activity: "idle",
      observationRevision: 1,
      startedAt: "2026-07-12T00:00:00.000Z",
      repoPath,
      watchedSavePath,
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    }),
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const conflict = await app.request("/api/v1/restores/in-place", {
    method: "POST",
    headers,
    body: JSON.stringify({
      commitRef: observed.observation.commit.ref,
      confirmation: "restore-watched-save",
      expectedCurrent: { status: "missing" },
    }),
  });
  const restored = await app.request("/api/v1/restores/in-place", {
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
