import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../app/App.tsx";

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

describe("History view", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    globalThis.location.hash = "#/history";
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(document, "visibilityState");
    globalThis.location.hash = "";
    vi.unstubAllGlobals();
  });

  it("keeps submitted event filters in the URL and resets pagination for a new query", async () => {
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
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/history?cursor=older-events")) {
          return Response.json({ events: [] });
        }
        if (url.includes("/api/v1/history")) {
          return Response.json({ events: [], nextCursor: "older-events" });
        }
        if (url.includes("/api/v1/search")) {
          return Response.json({ events: [] });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("history-view")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: "Load More" }));
    await waitFor(() => {
      expect(urls.some((url) => url.includes("cursor=older-events"))).toBe(
        true,
      );
    });

    fireEvent.input(getRequiredElement("#history-search-text"), {
      target: { value: "Bell Beast" },
    });
    fireEvent.change(getRequiredElement("#history-search-event-kind"), {
      target: { value: "itemStatusChanged" },
    });
    fireEvent.change(getRequiredElement("#history-search-target-status"), {
      target: { value: "done" },
    });
    fireEvent.change(getRequiredElement("#history-search-direction"), {
      target: { value: "progression" },
    });
    fireEvent.click(getRequiredElement("#history-search-include-filtered"));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(getLastRequest(urls, "/api/v1/search")).toBeDefined();
    });
    const searchRequest = getLastRequest(urls, "/api/v1/search");
    if (searchRequest === undefined) {
      throw new Error("Expected a History Search request.");
    }
    const searchUrl = new URL(searchRequest);
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      direction: "progression",
      eventType: "itemStatusChanged",
      includeFiltered: "true",
      statusTo: "done",
      text: "Bell Beast",
    });
    await waitFor(() => {
      expect(globalThis.location.hash).toContain("text=Bell+Beast");
    });
    expect(Object.fromEntries(getHashSearchParams())).toEqual({
      direction: "progression",
      eventType: "itemStatusChanged",
      includeFiltered: "true",
      statusTo: "done",
      text: "Bell Beast",
      view: "events",
    });

    fireEvent.input(getRequiredElement("#history-search-text"), {
      target: { value: "" },
    });
    fireEvent.change(getRequiredElement("#history-search-event-kind"), {
      target: { value: "" },
    });
    fireEvent.change(getRequiredElement("#history-search-target-status"), {
      target: { value: "" },
    });
    fireEvent.change(getRequiredElement("#history-search-direction"), {
      target: { value: "" },
    });
    fireEvent.click(getRequiredElement("#history-search-include-filtered"));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => {
      expect(urls.at(-1)).toContain("/api/v1/history");
    });
    await waitFor(() => {
      expect(globalThis.location.hash).toBe("#/history?view=events");
    });
  });

  it("restores a direct Observations URL before choosing which history data to load", async () => {
    globalThis.location.hash =
      "#/history?view=observations&text=Bell+Beast&eventType=itemStatusChanged&statusTo=done&direction=regression&includeFiltered=true";
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
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/observations")) {
          return Response.json({ entries: [] });
        }
        if (url.includes("/api/v1/search")) {
          return Response.json({ events: [] });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("history-observations")).toBeDefined();
    await waitFor(() => {
      expect(getLastRequest(urls, "/api/v1/observations")).toBeDefined();
    });
    expect(getLastRequest(urls, "/api/v1/history")).toBeUndefined();
    expect(getLastRequest(urls, "/api/v1/search")).toBeUndefined();
    expect(getRequiredInput("#history-search-text").value).toBe("Bell Beast");
    expect(getRequiredSelect("#history-search-event-kind").value).toBe(
      "itemStatusChanged",
    );
    expect(getRequiredSelect("#history-search-target-status").value).toBe(
      "done",
    );
    expect(getRequiredSelect("#history-search-direction").value).toBe(
      "regression",
    );
    expect(getRequiredInput("#history-search-include-filtered").checked).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Events" }));
    await waitFor(() => {
      expect(getLastRequest(urls, "/api/v1/search")).toBeDefined();
    });
    const searchRequest = getLastRequest(urls, "/api/v1/search");
    if (searchRequest === undefined) {
      throw new Error("Expected restored filters to select History Search.");
    }
    const searchUrl = new URL(searchRequest);
    expect(Object.fromEntries(searchUrl.searchParams)).toEqual({
      direction: "regression",
      eventType: "itemStatusChanged",
      includeFiltered: "true",
      statusTo: "done",
      text: "Bell Beast",
    });
    await waitFor(() => {
      expect(Object.fromEntries(getHashSearchParams())).toEqual({
        direction: "regression",
        eventType: "itemStatusChanged",
        includeFiltered: "true",
        statusTo: "done",
        text: "Bell Beast",
        view: "events",
      });
    });
  });

  it("loads more Events with the submitted query instead of unsubmitted form edits", async () => {
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
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/history")) {
          return Response.json({ events: [] });
        }
        if (url.includes("/api/v1/search")) {
          return Response.json(
            url.includes("cursor=older-search-events")
              ? { events: [] }
              : { events: [], nextCursor: "older-search-events" },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("history-view")).toBeDefined();
    fireEvent.input(getRequiredInput("#history-search-text"), {
      target: { value: "Bell Beast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const loadMore = await screen.findByRole("button", { name: "Load More" });

    fireEvent.input(getRequiredInput("#history-search-text"), {
      target: { value: "Moss Mother" },
    });
    fireEvent.click(loadMore);

    await waitFor(() => {
      const request = getLastRequest(urls, "/api/v1/search");
      expect(request).toContain("cursor=older-search-events");
    });
    const loadMoreRequest = getLastRequest(urls, "/api/v1/search");
    if (loadMoreRequest === undefined) {
      throw new Error("Expected a paginated History Search request.");
    }
    const loadMoreUrl = new URL(loadMoreRequest);
    expect(Object.fromEntries(loadMoreUrl.searchParams)).toEqual({
      cursor: "older-search-events",
      text: "Bell Beast",
    });
  });

  it("merges refreshed Events into already paginated History when the Watcher revision changes", async () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    let historyPageRequests = 0;
    let watcherRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          watcherRequests++;
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: watcherRequests,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("cursor=older-events")) {
          return Response.json({
            events: [createSummaryEvent("older", "older", "rosaries")],
          });
        }
        if (url.includes("/api/v1/history")) {
          historyPageRequests++;
          return Response.json(
            historyPageRequests === 1
              ? {
                  events: [
                    createSummaryEvent(
                      "initial",
                      "initial",
                      "completionPercentage",
                    ),
                  ],
                  nextCursor: "older-events",
                }
              : {
                  events: [
                    createSummaryEvent("newest", "newest", "shellShards"),
                  ],
                },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByText("completionPercentage")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    expect(await screen.findByText("rosaries")).toBeDefined();

    setDocumentVisibility("visible");
    await waitFor(() => {
      expect(watcherRequests).toBe(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    setDocumentVisibility("hidden");
    setDocumentVisibility("visible");

    expect(await screen.findByText("shellShards")).toBeDefined();
    expect(screen.getByText("completionPercentage")).toBeDefined();
    expect(screen.getByText("rosaries")).toBeDefined();
  });

  it("merges refreshed Raw Save Observations into their independently paginated history", async () => {
    globalThis.location.hash = "#/history?view=observations";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    let observationPageRequests = 0;
    let watcherRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          watcherRequests++;
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: watcherRequests,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("cursor=older-observations")) {
          return Response.json({
            entries: [createObservationEntry("older-observation")],
          });
        }
        if (url.includes("/api/v1/observations")) {
          observationPageRequests++;
          return Response.json(
            observationPageRequests === 1
              ? {
                  entries: [createObservationEntry("initial-observation")],
                  nextCursor: "older-observations",
                }
              : {
                  entries: [createObservationEntry("newest-observation")],
                },
          );
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByText("initial-observation")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    expect(await screen.findByText("older-observation")).toBeDefined();

    setDocumentVisibility("visible");
    await waitFor(() => {
      expect(watcherRequests).toBe(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    setDocumentVisibility("hidden");
    setDocumentVisibility("visible");

    expect(await screen.findByText("newest-observation")).toBeDefined();
    expect(screen.getByText("initial-observation")).toBeDefined();
    expect(screen.getByText("older-observation")).toBeDefined();
  });

  it("renders Events and Observations through one schema-aware commit card", async () => {
    const event = createSummaryEvent(
      "recognized-event",
      "recognized-commit",
      "completionPercentage",
    );
    const summarizedEvent = {
      ...event,
      snapshotSummary: {
        completionPercentage: 81,
        playTime: 9876,
        rosaries: 1234,
        shellShards: 88,
      },
    };
    const unrecognizedEntry = {
      ...createObservationEntry("unrecognized-commit"),
      observation: {
        ...createObservationEntry("unrecognized-commit").observation,
        schema: { status: "unrecognized", reason: "future-save-schema" },
      },
      // eslint-disable-next-line unicorn/no-null -- the Local HTTP wire contract uses explicit null when no Semantic Snapshot summary exists.
      snapshotSummary: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/meta")) {
          return Response.json(localHistoryMeta);
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/history")) {
          return Response.json({ events: [summarizedEvent] });
        }
        if (url.includes("/api/v1/observations")) {
          return Response.json({ entries: [unrecognizedEntry] });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    const eventCard = await screen.findByTestId("history-commit-card");
    expect(eventCard.textContent).toContain("Recognized schema");
    expect(eventCard.textContent).toContain("81%");
    expect(eventCard.textContent).toContain("9876");
    expect(eventCard.textContent).toContain("1234");
    expect(eventCard.textContent).toContain("88");
    expect(
      eventCard.querySelector('a[href*="/progress?commit="]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Observations" }));
    await waitFor(() => {
      expect(screen.getByText("unrecognized-commit")).toBeDefined();
    });
    const observationCard = screen.getByTestId("history-commit-card");
    expect(observationCard.textContent).toContain("Unrecognized schema");
    expect(observationCard.textContent).toContain("Summary unavailable");
    expect(
      observationCard.querySelector('a[href*="/raw-save?commit="]'),
    ).not.toBeNull();
    expect(
      observationCard.querySelector('a[href*="/progress?commit="]'),
    ).toBeNull();
    expect(observationCard.textContent).toContain("Export");
    expect(observationCard.textContent).toContain("Restore");
    expect(observationCard.textContent).toContain("Compare");
  });
});

function connectLocalHistory() {
  fireEvent.click(getRequiredElement("#connect-local-history"));
  fireEvent.input(getRequiredElement("#local-history-token"), {
    target: { value: "session-token" },
  });
  fireEvent.click(getRequiredElement("#local-history-connect"));
}

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`Expected ${selector} to exist.`);
  }

  return element;
}

function getRequiredInput(selector: string): HTMLInputElement {
  const element = getRequiredElement(selector);
  if (!(element instanceof HTMLInputElement)) {
    throw new TypeError(`Expected ${selector} to be an input.`);
  }

  return element;
}

function getRequiredSelect(selector: string): HTMLSelectElement {
  const element = getRequiredElement(selector);
  if (!(element instanceof HTMLSelectElement)) {
    throw new TypeError(`Expected ${selector} to be a select.`);
  }

  return element;
}

function getLastRequest(
  urls: readonly string[],
  path: string,
): string | undefined {
  return urls.findLast((url) => url.includes(path));
}

function getHashSearchParams(): URLSearchParams {
  return new URLSearchParams(globalThis.location.hash.split("?", 2)[1]);
}

function setDocumentVisibility(value: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

function createSummaryEvent(
  id: string,
  shortRef: string,
  metric: "completionPercentage" | "rosaries" | "shellShards",
) {
  const commit = {
    committedAt: "2026-07-15T00:00:00.000Z",
    ref: `${shortRef}-commit`,
    shortRef,
  };
  const version = {
    saveSchemaVersion: "1",
    semanticCoreVersion: "test",
  };
  return {
    id,
    commit,
    observation: {
      commit,
      observedAt: "2026-07-15T00:00:00.000Z",
      trigger: "watcher",
      sourcePath: "/tmp/user1.dat",
      encodedSha256: "a".repeat(64),
      decodedSha256: "b".repeat(64),
      decoderVersion: "test",
      schema: { status: "recognized", saveSchemaVersion: "1" },
    },
    snapshotSummary: {},
    event: {
      kind: "summaryMetric",
      eventType: "summaryMetricChanged",
      metric,
      beforeValue: 1,
      afterValue: 2,
      direction: "progression",
      isRegression: false,
      sourceReferences: [],
      version: { before: version, after: version },
    },
    visibility: { defaultVisible: true, filterReasons: [] },
  };
}

function createObservationEntry(shortRef: string) {
  const commit = {
    committedAt: "2026-07-15T00:00:00.000Z",
    ref: `${shortRef}-commit`,
    shortRef,
  };
  return {
    observation: {
      commit,
      observedAt: "2026-07-15T00:00:00.000Z",
      trigger: "watcher",
      sourcePath: "/tmp/user1.dat",
      encodedSha256: "a".repeat(64),
      decodedSha256: "b".repeat(64),
      decoderVersion: "test",
      schema: { status: "recognized", saveSchemaVersion: "1" },
    },
    snapshotSummary: {},
  };
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
