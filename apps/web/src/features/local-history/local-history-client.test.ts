import { describe, expect, it } from "vitest";

import {
  createLocalHistoryClient,
  LocalHistoryClientError,
} from "./local-history-client.ts";

describe("LocalHistoryClient", () => {
  it("reads authenticated Local History watcher status", async () => {
    const requests: Array<{
      readonly headers: HeadersInit | undefined;
      readonly url: string;
    }> = [];
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async (input, init) => {
        requests.push({ headers: init?.headers, url: requestUrl(input) });

        return Response.json({
          status: "running",
          activity: "idle",
          observationRevision: 0,
          startedAt: "2026-07-14T00:00:00.000Z",
          repoPath: "/tmp/history-repo",
          watchedSavePath: "/tmp/user1.dat",
          capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          futureField: true,
        });
      },
      token: "session-token",
    });

    await expect(client.getWatcher()).resolves.toEqual({
      status: "running",
      activity: "idle",
      observationRevision: 0,
      startedAt: "2026-07-14T00:00:00.000Z",
      repoPath: "/tmp/history-repo",
      watchedSavePath: "/tmp/user1.dat",
      capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4312/api/v1/watcher");
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer session-token");
  });

  it("classifies authentication failures without retrying", async () => {
    let requestCount = 0;
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () => {
        requestCount++;
        return Response.json(
          {
            error: {
              code: "unauthorized",
              message: "Authentication required.",
            },
          },
          { status: 401 },
        );
      },
      token: "bad-token",
    });

    const rejection = client.getWatcher();
    await expect(rejection).rejects.toBeInstanceOf(LocalHistoryClientError);
    await expect(rejection).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
    expect(requestCount).toBe(1);
  });

  it("classifies malformed watcher status as a protocol failure", async () => {
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () =>
        Response.json({ status: "running", observationRevision: "0" }),
      token: "session-token",
    });

    await expect(client.getWatcher()).rejects.toMatchObject({
      kind: "protocol",
      status: 200,
    });
  });

  it("accepts Save State items without unused category identifiers", async () => {
    const saveState = {
      status: "available" as const,
      observation: {
        commit: {
          ref: "abcdef1234567890",
          shortRef: "abcdef1",
          committedAt: "2026-07-14T00:00:00.000Z",
        },
        observedAt: "2026-07-14T00:00:00.000Z",
        trigger: "watcher",
        sourcePath: "/tmp/user1.dat",
        encodedSha256: "a".repeat(64),
        decodedSha256: "b".repeat(64),
        decoderVersion: "test",
        schema: { status: "recognized", saveSchemaVersion: "1" },
      },
      decodedSave: { playerData: {} },
      semanticSnapshot: {
        items: [
          {
            id: "mask-shard-2",
            label: "Mask Shard #2",
            sectionId: "main",
            type: "sceneBool",
            status: "done",
            value: true,
            sourceReferences: [
              {
                kind: "sceneFlag",
                scene: "Crawl_02",
                flag: "Heart Piece",
              },
            ],
          },
        ],
        summary: {},
        version: {
          saveSchemaVersion: "silksong-save-v1",
          semanticCoreVersion: "core-semantic-v1",
        },
      },
    };
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () => Response.json(saveState),
      token: "session-token",
    });

    await expect(client.getSave({ kind: "latest" })).resolves.toEqual(
      saveState,
    );
  });

  it("reads the authenticated in-place restore preflight", async () => {
    const requests: string[] = [];
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async (input) => {
        requests.push(requestUrl(input));
        return Response.json({
          status: "targetPresent",
          expectedCurrent: {
            status: "present",
            encodedSha256: "a".repeat(64),
          },
        });
      },
      token: "session-token",
    });

    await expect(client.getRestorePreflight()).resolves.toEqual({
      status: "targetPresent",
      expectedCurrent: {
        status: "present",
        encodedSha256: "a".repeat(64),
      },
    });
    expect(requests).toEqual([
      "http://127.0.0.1:4312/api/v1/restores/in-place/preflight",
    ]);
  });

  it("exposes Retry-After from repository-busy mutation failures", async () => {
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "repository_busy",
              message: "Save History Repository is busy.",
            },
          },
          {
            headers: { "Retry-After": "1" },
            status: 409,
          },
        ),
      token: "session-token",
    });

    await expect(
      client.restoreInPlace({
        commitRef: "source-commit",
        expectedCurrent: { status: "missing" },
      }),
    ).rejects.toMatchObject({
      code: "repository_busy",
      retryAfterMs: 1000,
    });
  });

  it("classifies a failed request as temporarily unavailable", async () => {
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () => {
        throw new TypeError("network unavailable");
      },
      token: "session-token",
    });

    await expect(client.getWatcher()).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}
