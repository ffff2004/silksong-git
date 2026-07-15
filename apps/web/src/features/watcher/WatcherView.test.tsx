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

describe("Watcher view", () => {
  beforeEach(() => {
    globalThis.location.hash = "#/watcher";
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(document, "visibilityState");
    globalThis.location.hash = "";
    vi.unstubAllGlobals();
  });

  it("renders the Runtime-owned Watcher status without starting another poll", async () => {
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
            activity: "observing",
            observationRevision: 3,
            startedAt: "2026-07-16T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: {
              debounceWriteMs: 750,
              minCommitIntervalMs: 5000,
            },
            lastObservation: {
              cause: "change",
              completedAt: "2026-07-16T00:01:00.000Z",
              status: "watcherError",
              error: {
                reason: "decodeFailure",
                message: "The Watched Save could not be decoded.",
              },
            },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();

    expect(await screen.findByTestId("watcher-view")).toBeDefined();
    expect(await screen.findByText("observing")).toBeDefined();
    expect(screen.getByText("/tmp/user1.dat")).toBeDefined();
    expect(
      screen.getByText("750 ms debounce, 5000 ms minimum interval"),
    ).toBeDefined();
    expect(screen.getByText("2026-07-16T00:01:00.000Z")).toBeDefined();
    expect(
      screen.getByText("The Watched Save could not be decoded."),
    ).toBeDefined();
    await waitFor(() => {
      expect(watcherRequests).toBe(1);
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

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) {
    return input.url;
  }

  return input.toString();
}
