/// <reference types="node" />

import type { SemanticItemEvent } from "@silksong-git/core";
import {
  createSemanticSnapshot,
  getBuiltinMappingData,
  parseDecodedSave,
} from "@silksong-git/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import decodedSave from "../test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json";
import { App } from "./App.tsx";

const intersectionState: {
  callback: IntersectionObserverCallback | undefined;
} = {
  callback: undefined,
};

const localHistoryMeta = {
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
  ],
};

const latestObservation = {
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
};

class MockIntersectionObserver {
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly root = document;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly takeRecords = vi.fn(Array<IntersectionObserverEntry>);
  readonly thresholds: readonly number[] = [];
  readonly unobserve = vi.fn();

  constructor(callback?: IntersectionObserverCallback) {
    intersectionState.callback = callback;
  }
}

describe("Solid Web app routing", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    intersectionState.callback = undefined;
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(document, "visibilityState");
    globalThis.localStorage.clear();
    globalThis.location.hash = "";
    vi.unstubAllGlobals();
  });

  it("shows Progress by default", async () => {
    render(() => <App />);

    expect(await screen.findByTestId("progress-view")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Progress" }).getAttribute("href"),
    ).toBe("#/progress");
  });

  it("keeps Local-only URLs behind a connection-required state", async () => {
    globalThis.location.hash = "#/history";
    render(() => <App />);

    expect(
      await screen.findByTestId("local-connection-required"),
    ).toBeDefined();
    expect(screen.getByText("Local History connection required")).toBeDefined();
  });

  it("connects Local History and clears the uploaded Static Save", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requestCount++;
        if (requestCount === 2) {
          return Response.json({
            status: "available",
            observation: latestObservation,
            decodedSave: { playerData: { geo: 1234 } },
            semanticSnapshot: {
              items: [],
              summary: {
                completionPercentage: 81,
                playTime: 9876,
                rosaries: 1234,
                shellShards: 88,
              },
              version: {
                saveSchemaVersion: "1",
                semanticCoreVersion: "test",
              },
            },
          });
        }

        return Response.json(localHistoryMeta);
      }),
    );

    render(() => <App />);
    await uploadDecodedSave();
    expect(document.querySelector("#modeBanner")?.textContent).toContain(
      "NORMAL SAVE LOADED",
    );

    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-endpoint"), {
      target: { value: "http://127.0.0.1:4312" },
    });
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    await waitFor(() => {
      expect(
        document.querySelector("#disconnect-local-history"),
      ).not.toBeNull();
    });
    expect(document.querySelector("#modeBanner")?.textContent).not.toContain(
      "NORMAL SAVE LOADED",
    );
    expect(
      document.querySelector('[data-testid="progress-view"]'),
    ).not.toBeNull();
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "81%",
      );
    });
    expect(document.querySelector("#playtimeValue")?.textContent).toBe(
      "2h 44m",
    );
    expect(document.querySelector("#rosariesValue")?.textContent).toBe("1234");
    expect(document.querySelector("#shardsValue")?.textContent).toBe("88");
    expect(document.querySelector("#upload-save")).toBeNull();
    expect(document.querySelector("#clearDataBtn")).toBeNull();
  });

  it("explains when browser Local Network Access was denied", async () => {
    const navigatorWithDeniedLoopbackPermission = Object.create(
      globalThis.navigator,
    ) as Navigator;
    Object.defineProperty(
      navigatorWithDeniedLoopbackPermission,
      "permissions",
      {
        configurable: true,
        value: {
          query: vi.fn(async () => ({ state: "denied" })),
        },
      },
    );
    vi.stubGlobal("navigator", navigatorWithDeniedLoopbackPermission);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    expect(
      await screen.findByText(
        "Local Network Access was denied. Allow this site to access the local network, then try again.",
      ),
    ).toBeDefined();
  });

  it("keeps loaded Local Save data visible when a later request makes the session stale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("commit=unavailable")) {
          throw new TypeError("Local endpoint became unavailable.");
        }

        return Response.json({
          status: "available",
          observation: latestObservation,
          decodedSave: { playerData: { geo: 1234 } },
          semanticSnapshot: {
            items: [],
            summary: {
              completionPercentage: 81,
              playTime: 9876,
              rosaries: 1234,
              shellShards: 88,
            },
            version: {
              saveSchemaVersion: "1",
              semanticCoreVersion: "test",
            },
          },
        });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "81%",
      );
    });

    globalThis.location.hash = "#/progress?commit=unavailable";
    globalThis.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(await screen.findByText("Local History stale")).toBeDefined();
    expect(document.querySelector("#completionValue")?.textContent).toBe("81%");
  });

  it("polls Watcher status only while the Local History page is visible", async () => {
    let watcherRequests = 0;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/watcher")) {
          watcherRequests++;
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 3,
            startedAt: "2026-07-14T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }

        return Response.json({ status: "empty" });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));
    await waitFor(() => {
      expect(
        document.querySelector("#disconnect-local-history"),
      ).not.toBeNull();
    });
    expect(watcherRequests).toBe(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(watcherRequests).toBe(1);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1100);
    });
    expect(watcherRequests).toBe(1);
  });

  it("refreshes moving latest on Watcher revision changes without replacing a historical selection", async () => {
    let latestSaveRequests = 0;
    let watcherRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/watcher")) {
          watcherRequests++;
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: watcherRequests,
            startedAt: "2026-07-14T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/save")) {
          const isHistorical = url.includes("commit=historical");
          if (!isHistorical) {
            latestSaveRequests++;
          }
          let completionPercentage = 70;
          if (!isHistorical) {
            completionPercentage = latestSaveRequests === 1 ? 81 : 82;
          }
          return Response.json({
            status: "available",
            observation: {
              ...latestObservation,
              commit: isHistorical
                ? {
                    ...latestObservation.commit,
                    ref: "historical",
                    shortRef: "historical",
                  }
                : latestObservation.commit,
            },
            decodedSave: { completionPercentage },
            semanticSnapshot: {
              items: [],
              summary: {
                completionPercentage,
                playTime: 9876,
                rosaries: 1234,
                shellShards: 88,
              },
              version: {
                saveSchemaVersion: "1",
                semanticCoreVersion: "test",
              },
            },
          });
        }

        return Response.json({ events: [] });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "81%",
      );
      expect(watcherRequests).toBe(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "82%",
      );
    });

    globalThis.location.hash = "#/progress?commit=historical";
    globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "70%",
      );
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(watcherRequests).toBe(3);
    });
    expect(document.querySelector("#completionValue")?.textContent).toBe("70%");
  });

  it("reports a newer latest observation and returns a historical selection to it", async () => {
    globalThis.location.hash = "#/progress?commit=historical";
    const latestCommit = {
      ...latestObservation.commit,
      ref: "latest",
      shortRef: "latest",
    };
    const historicalCommit = {
      ...latestObservation.commit,
      ref: "historical",
      shortRef: "historical",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 2,
            startedAt: "2026-07-14T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
            lastObservation: {
              cause: "change",
              completedAt: "2026-07-14T00:00:00.000Z",
              status: "committed",
              commit: latestCommit,
              eventCount: 1,
              semanticStatus: "updated",
            },
          });
        }
        if (url.includes("/api/v1/save")) {
          return Response.json(
            createAvailableLocalSaveState(
              url.includes("commit=historical") ? 70 : 82,
              url.includes("commit=historical")
                ? historicalCommit
                : latestCommit,
            ),
          );
        }

        return Response.json({ events: [] });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    expect(
      await screen.findByText("A newer latest save is available."),
    ).toBeDefined();
    expect(document.querySelector("#completionValue")?.textContent).toBe("70%");

    fireEvent.click(getRequiredElement("#back-to-latest"));
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "82%",
      );
    });
    expect(globalThis.location.hash).toBe("#/progress");
  });

  it("uses History for the empty search and Search API for submitted text", async () => {
    globalThis.location.hash = "#/history";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        return Response.json({ events: [] });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));
    expect(await screen.findByTestId("history-view")).toBeDefined();
    await waitFor(() => {
      expect(urls.some((url) => url.includes("/api/v1/history"))).toBe(true);
    });

    fireEvent.input(getRequiredElement("#history-search-text"), {
      target: { value: "Bell Beast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => {
      expect(
        urls.some((url) => url.includes("/api/v1/search?text=Bell+Beast")),
      ).toBe(true);
    });
  });

  it("loads older History Events and merges commit groups across cursor pages", async () => {
    globalThis.location.hash = "#/history";
    const snapshot = createWireSemanticSnapshot();
    const [firstItem, secondItem, thirdItem] = snapshot.items;
    if (
      firstItem === undefined
      || secondItem === undefined
      || thirdItem === undefined
    ) {
      throw new Error("Expected at least three Semantic Snapshot items.");
    }

    const newestCommit = {
      committedAt: "2026-07-14T00:00:00.000Z",
      ref: "newest-commit",
      shortRef: "newest",
    };
    const olderCommit = {
      committedAt: "2026-07-13T00:00:00.000Z",
      ref: "older-commit",
      shortRef: "older",
    };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/history?cursor=older-events")) {
          return Response.json({
            events: [
              createHistoricalItemEvent(
                "event-2",
                newestCommit,
                firstItem,
                snapshot.summary,
                snapshot.version,
              ),
              createHistoricalItemEvent(
                "event-3",
                olderCommit,
                thirdItem,
                snapshot.summary,
                snapshot.version,
              ),
            ],
          });
        }
        if (url.includes("/api/v1/history")) {
          return Response.json({
            events: [
              createHistoricalItemEvent(
                "event-1",
                newestCommit,
                secondItem,
                snapshot.summary,
                snapshot.version,
              ),
            ],
            nextCursor: "older-events",
          });
        }
        return Response.json({ events: [] });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    expect(await screen.findByText(secondItem.label)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    await waitFor(() => {
      expect(urls.some((url) => url.includes("cursor=older-events"))).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("history-commit-card")).toHaveLength(2);
    });
    expect(screen.getByText(firstItem.label)).toBeDefined();
    expect(screen.getByText(secondItem.label)).toBeDefined();
    expect(screen.getByText(thirdItem.label)).toBeDefined();
    expect(globalThis.location.hash).not.toContain("cursor=");
  });

  it("paginates Raw Save Observations with an independent cursor", async () => {
    globalThis.location.hash = "#/history";
    const snapshot = createWireSemanticSnapshot();
    const newestCommit = {
      committedAt: "2026-07-14T00:00:00.000Z",
      ref: "newest-observation-commit",
      shortRef: "newest-observation",
    };
    const olderCommit = {
      committedAt: "2026-07-13T00:00:00.000Z",
      ref: "older-observation-commit",
      shortRef: "older-observation",
    };
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        urls.push(url);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/history")) {
          return Response.json({
            events: [],
            nextCursor: "event-only-cursor",
          });
        }
        if (url.includes("/api/v1/observations?cursor=older-observations")) {
          return Response.json({
            entries: [
              {
                observation: { ...latestObservation, commit: olderCommit },
                snapshotSummary: snapshot.summary,
              },
            ],
          });
        }
        if (url.includes("/api/v1/observations")) {
          return Response.json({
            entries: [
              {
                observation: { ...latestObservation, commit: newestCommit },
                snapshotSummary: snapshot.summary,
              },
            ],
            nextCursor: "older-observations",
          });
        }
        return Response.json({ events: [] });
      }),
    );

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));
    expect(await screen.findByTestId("history-view")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Observations" }));
    expect(await screen.findByText("newest-observation")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));

    expect(await screen.findByText("older-observation")).toBeDefined();
    expect(urls.some((url) => url.includes("cursor=older-observations"))).toBe(
      true,
    );
    expect(
      urls.some(
        (url) =>
          url.includes("/api/v1/observations")
          && url.includes("cursor=event-only-cursor"),
      ),
    ).toBe(false);
    expect(globalThis.location.hash).not.toContain("cursor=");
  });

  it("renders Semantic Diff changes through the Progress view seam", async () => {
    globalThis.location.hash = "#/diff?from=before&to=after";
    const before = createWireSemanticSnapshot();
    const changedItem = before.items.find(
      (item) => item.label === "Mask Shard #2",
    );
    if (changedItem === undefined) {
      throw new Error("Expected Mask Shard #2 in the snapshot.");
    }

    const after = {
      ...before,
      items: before.items.map((item) =>
        item.id === changedItem.id
          ? { ...item, status: "missing" as const }
          : item,
      ),
    };
    const event: SemanticItemEvent = {
      kind: "item",
      eventType: "itemStatusChanged",
      item: {
        id: changedItem.id,
        label: changedItem.label,
        sectionId: changedItem.sectionId,
        type: changedItem.type,
      },
      before: { status: changedItem.status, value: changedItem.value },
      after: { status: "missing", value: changedItem.value },
      direction: "regression",
      isRegression: true,
      sourceReferences: changedItem.sourceReferences,
      version: { before: before.version, after: after.version },
    };
    const fromCommit = {
      committedAt: "2026-07-13T00:00:00.000Z",
      ref: "before",
      shortRef: "before",
    };
    const toCommit = {
      committedAt: "2026-07-14T00:00:00.000Z",
      ref: "after",
      shortRef: "after",
    };
    const diff = {
      after,
      before,
      events: [
        {
          commit: toCommit,
          event,
          id: "event-1",
          observation: { ...latestObservation, commit: toCommit },
          previousCommit: fromCommit,
          snapshotSummary: after.summary,
          visibility: { defaultVisible: true, filterReasons: [] },
        },
      ],
      from: fromCommit,
      to: toCommit,
    };
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url.includes("/api/v1/meta")) {
        return Response.json(localHistoryMeta);
      }
      if (url.includes("/api/v1/save")) {
        if (url.includes("commit=before")) {
          return Response.json({
            decodedSave: { before: true },
            observation: { ...latestObservation, commit: fromCommit },
            semanticSnapshot: before,
            status: "available",
          });
        }
        if (url.includes("commit=after")) {
          return Response.json({
            decodedSave: { after: true },
            observation: { ...latestObservation, commit: toCommit },
            semanticSnapshot: after,
            status: "available",
          });
        }
        return Response.json({ status: "empty" });
      }
      if (url.includes("/api/v1/diff")) {
        return Response.json(diff);
      }
      return Response.json({ events: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(() => <App />);
    fireEvent.click(getRequiredElement("#connect-local-history"));
    fireEvent.input(getRequiredElement("#local-history-token"), {
      target: { value: "session-token" },
    });
    fireEvent.click(getRequiredElement("#local-history-connect"));

    expect(await screen.findByTestId("diff-view")).toBeDefined();
    fireEvent.input(getRequiredElement("#diff-from"), {
      target: { value: "before" },
    });
    fireEvent.input(getRequiredElement("#diff-to"), {
      target: { value: "after" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(urls.some((url) => url.includes("/api/v1/diff"))).toBe(true);
    });
    await waitFor(() => {
      expect(getProgressCard("Mask Shard #2")).toBeDefined();
    });
    expect(getProgressCard("Shining Needle")).toBeUndefined();
    expect(getButtonByText("Show unchanged")).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId("raw-save-diff-fallback")).toBeDefined();
    });
    const rawDiff = screen.getByTestId("raw-save-diff-fallback");
    expect(rawDiff.textContent).toContain('"before": true');
    expect(rawDiff.textContent).toContain('"after": true');
  });

  it("loads decoded JSON through Static Web Mode and renders summary metrics", async () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();

    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    expect(document.querySelector("#modeBanner")?.textContent).toContain(
      "NORMAL SAVE LOADED",
    );
    expect(document.querySelector("#playtimeValue")?.textContent).toBe(
      "24h 12m",
    );
    expect(document.querySelector("#rosariesValue")?.textContent).toBe("800");
    expect(document.querySelector("#shardsValue")?.textContent).toBe("76");
  });

  it("applies Static Web Mode preference filters to progress rendering", async () => {
    const { container } = render(() => <App />);

    expect(screen.getByText("Base Needle")).toBeDefined();
    fireEvent.click(getRequiredElement("#acts-dropdown-button"));
    fireEvent.click(getRequiredElement('#acts-dropdown-menu input[value="2"]'));
    fireEvent.click(getRequiredElement('#acts-dropdown-menu input[value="3"]'));

    expect(screen.queryByText("Shining Needle")).toBeNull();
    expect(screen.getByText("Base Needle")).toBeDefined();

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();
    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    fireEvent.click(getRequiredElement("#show-only-missing"));
    expect(container.querySelector(".boss.done")).toBeNull();
  });

  it("reveals undiscovered progress items when Show spoilers is enabled", () => {
    render(() => <App />);

    const card = screen.getByText("Shining Needle").closest(".boss");
    if (card === null) {
      throw new Error("Expected Shining Needle card to exist.");
    }

    expect(card.classList.contains("locked")).toBe(true);
    expect(card.querySelector("img")?.getAttribute("src")).toContain(
      "locked.png",
    );

    fireEvent.click(getRequiredElement("#show-spoilers"));

    expect(card.classList.contains("locked")).toBe(false);
    expect(card.querySelector("img")?.getAttribute("src")).not.toContain(
      "locked.png",
    );
  });

  it("keeps the progress TOC collapsible, counted, and synced to scroll", () => {
    render(() => <App />);

    const categories = document.querySelectorAll(".toc-category");
    expect(categories.length).toBeGreaterThan(1);
    expect(document.querySelector(".toc-category.open")).toBeNull();
    expect(document.querySelector(".toc-sublist:not(.hidden)")).toBeNull();

    const firstCategory = getRequiredElement(".toc-category > a");
    const firstCategoryItem = firstCategory.closest(".toc-category");
    if (firstCategoryItem === null) {
      throw new Error("Expected first TOC category to exist.");
    }

    fireEvent.click(firstCategory);
    expect(firstCategoryItem.classList.contains("open")).toBe(true);
    expect(firstCategoryItem.querySelector(".toc-sublist.hidden")).toBeNull();

    fireEvent.click(firstCategory);
    expect(firstCategoryItem.classList.contains("open")).toBe(false);
    expect(
      firstCategoryItem.querySelector(".toc-sublist.hidden"),
    ).not.toBeNull();

    expect(document.querySelector(".toc-item a")?.textContent).toMatch(
      /\b\d+\/\d+\b/,
    );

    const headings = document.querySelectorAll<HTMLElement>(
      "#allprogress-grid h3",
    );
    expect(headings.length).toBeGreaterThan(1);
    const targetHeading = headings[1];
    if (targetHeading === undefined) {
      throw new Error("Expected second progress category heading to exist.");
    }
    intersectionState.callback?.(
      [createIntersectionEntry(targetHeading)],
      new MockIntersectionObserver(),
    );

    const activeLink = document.querySelector(".toc-item a.active");
    expect(activeLink?.getAttribute("href")).toBe(`#${targetHeading.id}`);
    expect(
      activeLink?.closest(".toc-category")?.classList.contains("open"),
    ).toBe(true);
    expect(document.querySelectorAll(".toc-category.open").length).toBe(1);
  });

  it("keeps the progress legend in the progress view and persists its collapsed state", () => {
    const { unmount } = render(() => <App />);

    const progressSection = getRequiredElement("#allprogress-section");
    const legend = progressSection.querySelector(".progress-legend");
    expect(legend).not.toBeNull();
    expect(
      document.querySelector(".toc-container .progress-legend"),
    ).toBeNull();
    expect(screen.getByText("Upgrade of another tool")).toBeDefined();

    const collapseButton = getRequiredElement(".progress-legend-toggle");
    expect(collapseButton.getAttribute("aria-label")).toBe("Collapse legend");
    fireEvent.click(collapseButton);
    expect(screen.queryByText("Upgrade of another tool")).toBeNull();
    expect(globalThis.localStorage.getItem("progressLegendCollapsed")).toBe(
      "true",
    );

    unmount();
    cleanup();
    render(() => <App />);

    expect(screen.queryByText("Upgrade of another tool")).toBeNull();
    expect(
      getRequiredElement(".progress-legend-toggle").getAttribute("aria-label"),
    ).toBe("Expand legend");
  });

  it("shows Raw Save and Map routes from loaded Static Web Mode state", async () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#upload-save"));
    const fileInput = getRequiredFileInput();
    const file = new File([JSON.stringify(decodedSave)], "save.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(document.querySelector("#completionValue")?.textContent).toBe(
        "39%",
      );
    });

    fireEvent.click(screen.getByRole("link", { name: "Raw Save Data" }));
    expect(await screen.findByTestId("raw-save-view")).toBeDefined();
    expect(screen.getByTestId("raw-save-fallback").textContent).toContain(
      "completionPercentage",
    );

    fireEvent.click(screen.getByRole("link", { name: "Interactive Map" }));
    expect(await screen.findByTestId("map-view")).toBeDefined();
    expect(document.querySelector("#worldMap")).not.toBeNull();
    expect(document.querySelectorAll(".map-pin").length).toBeGreaterThan(0);
  });

  it("shows progress item map locations in the shared interactive map canvas", () => {
    render(() => <App />);

    fireEvent.click(getRequiredElement("#progress-bell_beast"));

    const modal = getRequiredElement("#info-overlay");
    const canvas = modal.querySelector(".interactive-map-canvas");
    if (canvas === null) {
      throw new Error("Expected modal map canvas to exist.");
    }

    expect(canvas.classList.contains("interactive-map-canvas-modal")).toBe(
      true,
    );
    expect(canvas.querySelector("img")?.getAttribute("src")).toContain(
      "labelled_map_act3.png",
    );
    expect(
      canvas.querySelector<HTMLElement>('.map-pin[aria-label="Bell Beast"]'),
    ).not.toBeNull();

    const image = canvas.querySelector<HTMLImageElement>(
      ".interactive-map-image",
    );
    const stage = canvas.querySelector<HTMLElement>(".interactive-map-stage");
    if (image === null || stage === null) {
      throw new Error("Expected modal map image and stage to exist.");
    }

    setReadonlyNumberProperty(canvas, "clientWidth", 100);
    setReadonlyNumberProperty(canvas, "clientHeight", 50);
    setReadonlyNumberProperty(image, "naturalWidth", 100);
    setReadonlyNumberProperty(image, "naturalHeight", 100);
    fireEvent.load(image);

    const transform = parseMapTransform(stage.style.transform);
    expect(transform.x).toBeCloseTo(42.4);
    expect(transform.y).toBeCloseTo(-34);
    expect(transform.scale).toBe(2);
  });

  it("zooms the map around the mouse pointer", async () => {
    render(() => <App />);

    fireEvent.click(screen.getByRole("link", { name: "Interactive Map" }));
    expect(await screen.findByTestId("map-view")).toBeDefined();

    const canvas = getRequiredElement(".interactive-map-canvas");
    const image = canvas.querySelector<HTMLImageElement>(
      ".interactive-map-image",
    );
    const stage = canvas.querySelector<HTMLElement>(".interactive-map-stage");
    if (image === null || stage === null) {
      throw new Error("Expected map image and stage to exist.");
    }

    setReadonlyNumberProperty(canvas, "clientWidth", 100);
    setReadonlyNumberProperty(canvas, "clientHeight", 50);
    setReadonlyNumberProperty(image, "naturalWidth", 100);
    setReadonlyNumberProperty(image, "naturalHeight", 100);
    setElementRect(canvas, {
      height: 50,
      left: 0,
      top: 0,
      width: 100,
    });
    fireEvent.load(image);

    fireEvent.wheel(canvas, { clientX: 75, clientY: 35, deltaY: -100 });

    const transform = parseMapTransform(stage.style.transform);
    expect(transform.x).toBeCloseTo(-2.5);
    expect(transform.y).toBeCloseTo(-1);
    expect(transform.scale).toBeCloseTo(0.495);
  });

  it("resets upload platform pill styling for both links and buttons", () => {
    const pillRule = getCssRuleBody(".pill");
    const pillHoverRule = getCssRuleBody(".pill:hover");

    expect(pillRule).toContain("appearance: none;");
    expect(pillRule).toContain("box-sizing: content-box;");
    expect(pillRule).toContain("color: var(--accent);");
    expect(pillHoverRule).toContain("background: #2a2a2a;");
    expect(pillHoverRule).toContain("color: #e69b50;");
    expect(pillHoverRule).toContain(
      "text-shadow: 0 0 8px rgba(197, 106, 45, 0.4);",
    );
  });

  it("lets button-rendered controls inherit the page font", () => {
    const buttonRule = getCssRuleBody("button");

    expect(buttonRule).toContain("font: inherit;");
  });
});

function getRequiredFileInput(): HTMLInputElement {
  const fileInput = document.querySelector<HTMLInputElement>("#fileInput");
  if (fileInput === null) {
    throw new Error("Expected upload file input to exist.");
  }

  return fileInput;
}

async function uploadDecodedSave() {
  fireEvent.click(getRequiredElement("#upload-save"));
  const fileInput = getRequiredFileInput();
  const file = new File([JSON.stringify(decodedSave)], "save.json", {
    type: "application/json",
  });
  fireEvent.change(fileInput, { target: { files: [file] } });
  await waitFor(() => {
    expect(document.querySelector("#completionValue")?.textContent).toBe("39%");
  });
}

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`Expected ${selector} to exist.`);
  }

  return element;
}

function getProgressCard(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(".boss")].find(
    (card) => card.querySelector(".title")?.textContent === label,
  );
}

function createWireSemanticSnapshot() {
  const mapping = getBuiltinMappingData();
  return createSemanticSnapshot(parseDecodedSave(decodedSave), mapping);
}

function createAvailableLocalSaveState(
  completionPercentage: number,
  commit: typeof latestObservation.commit,
) {
  return {
    status: "available",
    observation: { ...latestObservation, commit },
    decodedSave: { completionPercentage },
    semanticSnapshot: {
      items: [],
      summary: {
        completionPercentage,
        playTime: 9876,
        rosaries: 1234,
        shellShards: 88,
      },
      version: {
        saveSchemaVersion: "1",
        semanticCoreVersion: "test",
      },
    },
  };
}

function createHistoricalItemEvent(
  id: string,
  commit: typeof latestObservation.commit,
  item: ReturnType<typeof createWireSemanticSnapshot>["items"][number],
  snapshotSummary: ReturnType<typeof createWireSemanticSnapshot>["summary"],
  snapshotVersion: ReturnType<typeof createWireSemanticSnapshot>["version"],
) {
  return {
    commit,
    event: {
      after: { status: item.status, value: item.value },
      before: { status: "missing", value: false },
      direction: "progression",
      eventType: "itemStatusChanged",
      isRegression: false,
      item: {
        id: item.id,
        label: item.label,
        sectionId: item.sectionId,
        type: item.type,
      },
      kind: "item",
      sourceReferences: item.sourceReferences,
      version: {
        after: snapshotVersion,
        before: snapshotVersion,
      },
    },
    id,
    observation: { ...latestObservation, commit },
    snapshotSummary,
    visibility: { defaultVisible: true, filterReasons: [] },
  };
}

function getButtonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent.trim() === label,
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function getCssRuleBody(selector: string): string {
  const stylesheet = readFileSync("public/assets/css/style.css", "utf8");
  const rulePattern = new RegExp(
    String.raw`${escapeRegExp(selector)}\s*\{([^}]*)\}`,
  );
  const match = rulePattern.exec(stylesheet);
  if (match?.[1] === undefined) {
    throw new Error(`Expected ${selector} CSS rule to exist.`);
  }

  return match[1];
}

function createIntersectionEntry(target: Element): IntersectionObserverEntry {
  const rect = target.getBoundingClientRect();

  return {
    boundingClientRect: rect,
    intersectionRatio: 1,
    intersectionRect: rect,
    isIntersecting: true,
    rootBounds: rect,
    target,
    time: 0,
  };
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

function setReadonlyNumberProperty(
  object: object,
  property: "clientHeight" | "clientWidth" | "naturalHeight" | "naturalWidth",
  value: number,
) {
  Object.defineProperty(object, property, { configurable: true, value });
}

function setElementRect(
  element: Element,
  rect: Pick<DOMRect, "height" | "left" | "top" | "width">,
) {
  element.getBoundingClientRect = vi.fn(() => ({
    bottom: rect.top + rect.height,
    height: rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
    toJSON: vi.fn(),
  }));
}

function parseMapTransform(value: string): {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
} {
  const match =
    /translate3d\((?<x>-?\d+(?:\.\d+)?)px, (?<y>-?\d+(?:\.\d+)?)px, 0\) scale\((?<scale>\d+(?:\.\d+)?)\)/u.exec(
      value,
    );
  const groups = match?.groups;
  if (
    groups?.["x"] === undefined
    || groups["y"] === undefined
    || groups["scale"] === undefined
  ) {
    throw new Error(`Expected map transform, got ${value}.`);
  }

  return {
    scale: Number(groups["scale"]),
    x: Number(groups["x"]),
    y: Number(groups["y"]),
  };
}
