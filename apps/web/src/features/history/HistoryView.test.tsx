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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}
