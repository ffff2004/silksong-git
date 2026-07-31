import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App as RuntimeApp } from "../../app/App.tsx";
import { createDesktopRuntimeCapabilities } from "../../runtime-capabilities/desktop.ts";
import { desktopTestRuntimeCapabilities } from "../../test/desktop-runtime-capabilities.ts";

const App = () => (
  <RuntimeApp runtimeCapabilities={desktopTestRuntimeCapabilities} />
);

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

  it("renders an inactive watcher without inventing active configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "inactive",
            observationRevision: 0,
            repoPath: "/tmp/history-repo",
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();

    expect(await screen.findByText("inactive")).toBeDefined();
    expect(screen.queryByText("Watched path")).toBeNull();
    expect(screen.queryByText("Capture Policy")).toBeNull();
  });

  it("starts and stops only the current Desktop Repo Session", async () => {
    let watching = false;
    const startWatching = vi.fn(async () => {
      watching = true;
    });
    const stopWatching = vi.fn(async () => {
      watching = false;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json(
            watching
              ? {
                  status: "running",
                  activity: "idle",
                  observationRevision: 0,
                  startedAt: "2026-07-16T00:00:00.000Z",
                  repoPath: "/tmp/history-repo",
                  watchedSavePath: "/tmp/user1.dat",
                  capturePolicy: {
                    debounceWriteMs: 500,
                    minCommitIntervalMs: 0,
                  },
                }
              : {
                  status: "inactive",
                  observationRevision: 0,
                  repoPath: "/tmp/history-repo",
                },
          );
        }

        throw new Error(`Unexpected Local HTTP request: ${url}`);
      }),
    );
    const runtimeCapabilities = createDesktopRuntimeCapabilities({
      getRepoSessionConnection: () => ({
        endpoint: "http://127.0.0.1:4312",
        token: "session-token",
      }),
      openExternalRepository: async () => ({ kind: "opened" }),
      startWatching,
      stopWatching,
    });

    render(() => <RuntimeApp runtimeCapabilities={runtimeCapabilities} />);
    connectLocalHistory();
    fireEvent.click(
      await screen.findByRole("button", { name: "Start Watching" }),
    );

    await waitFor(() => {
      expect(startWatching).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Stop Watching" }),
      ).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop Watching" }));
    await waitFor(() => {
      expect(stopWatching).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Start Watching" }),
      ).toBeDefined();
    });
  });

  it("keeps Local History connected and polling when another process owns the watcher", async () => {
    let watcherRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          watcherRequests++;
          return Response.json({
            status: "inactive",
            observationRevision: 0,
            repoPath: "/tmp/history-repo",
          });
        }

        throw new Error(`Unexpected Local HTTP request: ${url}`);
      }),
    );
    const startWatching = vi.fn(async () => {
      throw new Error(
        "Watching could not start. Another process may already be watching this repository; history browsing is still available.",
      );
    });
    const runtimeCapabilities = createDesktopRuntimeCapabilities({
      getRepoSessionConnection: () => ({
        endpoint: "http://127.0.0.1:4312",
        token: "session-token",
      }),
      openExternalRepository: async () => ({ kind: "opened" }),
      startWatching,
      stopWatching: async () => undefined,
    });

    render(() => <RuntimeApp runtimeCapabilities={runtimeCapabilities} />);
    connectLocalHistory();
    expect(await screen.findByTestId("watcher-view")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Start Watching" }));

    expect(
      await screen.findByText(
        "Watching could not start. Another process may already be watching this repository; history browsing is still available.",
      ),
    ).toBeDefined();
    expect(screen.getByTestId("watcher-view")).toBeDefined();
    expect(screen.getByText("Local History connected")).toBeDefined();
    expect(screen.queryByText("Local History stale")).toBeNull();
    const startButton = screen.getByRole("button", {
      name: "Start Watching",
    });
    expect(startButton.getAttribute("disabled")).toBeNull();
    fireEvent.click(startButton);
    await waitFor(() => {
      expect(startWatching).toHaveBeenCalledTimes(2);
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
      expect(watcherRequests).toBe(2);
    });
    expect(screen.getByText("Local History connected")).toBeDefined();
  });

  it("submits an optional Manual Checkpoint message once and renders every result", async () => {
    const checkpointBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-16T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: {
              debounceWriteMs: 500,
              minCommitIntervalMs: 0,
            },
          });
        }
        if (url.includes("/api/v1/checkpoints")) {
          const body = init?.body;
          if (typeof body !== "string") {
            throw new TypeError("Expected a Manual Checkpoint JSON body.");
          }
          checkpointBodies.push(JSON.parse(body));
          if (checkpointBodies.length === 1) {
            return Response.json({
              status: "committed",
              observation: {
                commit: {
                  ref: "checkpoint-commit",
                  shortRef: "checkpo",
                  committedAt: "2026-07-16T00:02:00.000Z",
                },
                observedAt: "2026-07-16T00:02:00.000Z",
                trigger: "manualCheckpoint",
                message: "before risky operation",
                sourcePath: "/tmp/user1.dat",
                encodedSha256: "a".repeat(64),
                decodedSha256: "b".repeat(64),
                decoderVersion: "test",
                schema: { status: "recognized", saveSchemaVersion: "1" },
              },
              semanticUpdate: {
                status: "notAvailable",
                reason: "readModelUnavailable",
              },
            });
          }
          if (checkpointBodies.length === 2) {
            return Response.json({
              status: "skipped",
              reason: "unchanged",
              encodedSha256: "a".repeat(64),
            });
          }

          return Response.json({
            status: "watcherError",
            error: {
              reason: "readFailure",
              message: "The Watched Save could not be read.",
            },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("watcher-view")).toBeDefined();

    fireEvent.input(getRequiredElement("#checkpoint-message"), {
      target: { value: "before risky operation" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create checkpoint" }),
    );
    expect(
      await screen.findByText("Checkpoint committed as checkpo."),
    ).toBeDefined();
    expect(checkpointBodies).toEqual([{ message: "before risky operation" }]);

    fireEvent.input(getRequiredElement("#checkpoint-message"), {
      target: { value: "" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Create checkpoint" }),
    );
    expect(
      await screen.findByText("Checkpoint skipped: unchanged."),
    ).toBeDefined();

    fireEvent.click(
      await screen.findByRole("button", { name: "Create checkpoint" }),
    );
    expect(
      await screen.findByText("The Watched Save could not be read."),
    ).toBeDefined();
    expect(checkpointBodies).toEqual([
      { message: "before risky operation" },
      {},
      {},
    ]);
  });

  it("submits explicit allowUnchanged intent once", async () => {
    const checkpointBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }
        if (url.includes("/api/v1/watcher")) {
          return Response.json({
            status: "running",
            activity: "idle",
            observationRevision: 0,
            startedAt: "2026-07-16T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: {
              debounceWriteMs: 500,
              minCommitIntervalMs: 0,
            },
          });
        }
        if (url.includes("/api/v1/checkpoints")) {
          const body = init?.body;
          if (typeof body !== "string") {
            throw new TypeError("Expected a Manual Checkpoint JSON body.");
          }
          checkpointBodies.push(JSON.parse(body));
          return Response.json({
            status: "skipped",
            reason: "unchanged",
            encodedSha256: "a".repeat(64),
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("watcher-view")).toBeDefined();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Allow unchanged save" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create checkpoint" }));

    expect(
      await screen.findByText("Checkpoint skipped: unchanged."),
    ).toBeDefined();
    expect(checkpointBodies).toEqual([{ allowUnchanged: true }]);
  });
});

function connectLocalHistory() {
  fireEvent.click(getRequiredElement("#connect-local-history"));
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
