import { describe, expect, it } from "vitest";

import {
  assertLocalHistoryCompatibility,
  createLocalHistoryClient,
  LocalHistoryClientError,
} from "./local-history-client.ts";

describe("LocalHistoryClient", () => {
  it("reads authenticated Local History metadata", async () => {
    const requests: Array<{
      readonly headers: HeadersInit | undefined;
      readonly url: string;
    }> = [];
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async (input, init) => {
        requests.push({ headers: init?.headers, url: requestUrl(input) });

        return Response.json(
          {
            api: {
              name: "silksong-git-local-history",
              version: { major: 1, minor: 1 },
            },
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capabilities: ["saveState", "futureCapability"],
            futureField: true,
          },
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        );
      },
      token: "session-token",
    });

    await expect(client.getMeta()).resolves.toEqual({
      api: {
        name: "silksong-git-local-history",
        version: { major: 1, minor: 1 },
      },
      capabilities: ["saveState", "futureCapability"],
      repoPath: "/tmp/history-repo",
      watchedSavePath: "/tmp/user1.dat",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:4312/api/v1/meta");
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer session-token");
  });

  it("accepts a compatible metadata response with additional capabilities", () => {
    expect(() => {
      assertLocalHistoryCompatibility({
        api: {
          name: "silksong-git-local-history",
          version: { major: 1, minor: 1 },
        },
        repoPath: "/tmp/history-repo",
        watchedSavePath: "/tmp/user1.dat",
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
          "futureCapability",
        ],
      });
    }).not.toThrow();
  });

  it("rejects an older API version as incompatible", () => {
    expect(() => {
      assertLocalHistoryCompatibility({
        api: {
          name: "silksong-git-local-history",
          version: { major: 1, minor: 0 },
        },
        repoPath: "/tmp/history-repo",
        watchedSavePath: "/tmp/user1.dat",
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
    }).toThrow(expect.objectContaining({ kind: "incompatible" }));
  });

  it("rejects metadata missing a required capability", () => {
    expect(() => {
      assertLocalHistoryCompatibility({
        api: {
          name: "silksong-git-local-history",
          version: { major: 1, minor: 1 },
        },
        repoPath: "/tmp/history-repo",
        watchedSavePath: "/tmp/user1.dat",
        capabilities: [
          "watcherStatus",
          "saveState",
          "history",
          "rawObservations",
          "diff",
          "search",
          "checkpoint",
          "exportEncodedSave",
        ],
      });
    }).toThrow(expect.objectContaining({ kind: "incompatible" }));
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

    const rejection = client.getMeta();
    await expect(rejection).rejects.toBeInstanceOf(LocalHistoryClientError);
    await expect(rejection).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
    expect(requestCount).toBe(1);
  });

  it("classifies malformed metadata as a protocol failure", async () => {
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () =>
        Response.json({
          api: {
            name: "silksong-git-local-history",
            version: { major: 1, minor: "1" },
          },
          repoPath: "/tmp/history-repo",
          watchedSavePath: "/tmp/user1.dat",
          capabilities: [],
        }),
      token: "session-token",
    });

    await expect(client.getMeta()).rejects.toMatchObject({
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

  it("classifies a failed request as temporarily unavailable", async () => {
    const client = createLocalHistoryClient({
      endpoint: "http://127.0.0.1:4312",
      fetch: async () => {
        throw new TypeError("network unavailable");
      },
      token: "session-token",
    });

    await expect(client.getMeta()).rejects.toMatchObject({
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
