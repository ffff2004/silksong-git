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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../app/App.tsx";
import decodedSave from "../../test-fixtures/mask-shard-2-collected-rosaries-save.decoded.json";

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
    ref: "latest",
    shortRef: "latest",
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

describe("Diff view", () => {
  beforeEach(() => {
    window.scrollTo = vi.fn();
    globalThis.location.hash = "#/diff?from=before&to=after";
  });

  afterEach(() => {
    cleanup();
    globalThis.location.hash = "";
    vi.unstubAllGlobals();
  });

  it("keeps submitted refs in the URL and exposes Semantic and Raw JSON tabs", async () => {
    const snapshot = createSemanticSnapshot(
      parseDecodedSave(decodedSave),
      getBuiltinMappingData(),
    );
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
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/diff")) {
          return Response.json({
            before: snapshot,
            after: snapshot,
            events: [],
            from: createCommit("new-before"),
            to: createCommit("new-after"),
          });
        }
        if (url.includes("/api/v1/save") && url.includes("commit=")) {
          const commit = createCommit(
            url.includes("new-before") ? "new-before" : "new-after",
          );
          return Response.json({
            status: "available",
            observation: { ...latestObservation, commit },
            decodedSave: { commit: commit.ref },
            semanticSnapshot: snapshot,
          });
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("diff-view")).toBeDefined();
    expect(getRequiredInput("#diff-from").value).toBe("before");
    expect(getRequiredInput("#diff-to").value).toBe("after");

    fireEvent.input(getRequiredInput("#diff-from"), {
      target: { value: "new-before" },
    });
    fireEvent.input(getRequiredInput("#diff-to"), {
      target: { value: "new-after" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await waitFor(() => {
      expect(globalThis.location.hash).toBe(
        "#/diff?from=new-before&to=new-after",
      );
    });
    expect(
      screen
        .getByRole("tab", { name: "Semantic" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("progress-view")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "Raw JSON" }));
    expect(
      screen
        .getByRole("tab", { name: "Raw JSON" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(await screen.findByTestId("raw-save-diff-fallback")).toBeDefined();
    expect(screen.queryByTestId("progress-view")).toBeNull();
  });

  it("keeps the Raw JSON comparison when Semantic Diff fails", async () => {
    const requestedCommits: string[] = [];
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
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/diff")) {
          return Response.json(
            {
              error: {
                code: "read_model_unavailable",
                message: "Semantic Diff is temporarily unavailable.",
              },
            },
            { status: 503 },
          );
        }
        if (url.includes("/api/v1/save") && url.includes("commit=")) {
          const saveUrl = new URL(url);
          const commitRef = saveUrl.searchParams.get("commit");
          if (commitRef === null) {
            throw new Error("Expected a commit-selected Save State request.");
          }
          requestedCommits.push(commitRef);
          return Response.json({
            status: "available",
            observation: {
              ...latestObservation,
              commit: createCommit(commitRef),
            },
            decodedSave: { commit: commitRef },
            // eslint-disable-next-line unicorn/no-null -- null is the wire value for an unavailable Semantic Snapshot.
            semanticSnapshot: null,
          });
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("diff-view")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    expect(await screen.findByRole("tab", { name: "Raw JSON" })).toBeDefined();
    expect(requestedCommits.toSorted()).toEqual(["after", "before"]);
    fireEvent.click(screen.getByRole("tab", { name: "Raw JSON" }));
    const rawDiff = await screen.findByTestId("raw-save-diff-fallback");
    expect(rawDiff.textContent).toContain('"commit": "before"');
    expect(rawDiff.textContent).toContain('"commit": "after"');
    expect(screen.queryByTestId("progress-view")).toBeNull();
  });

  it("selects Raw JSON and explains Semantic Diff for an Unrecognized Schema Observation", async () => {
    const snapshot = createSemanticSnapshot(
      parseDecodedSave(decodedSave),
      getBuiltinMappingData(),
    );
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
            observationRevision: 0,
            startedAt: "2026-07-15T00:00:00.000Z",
            repoPath: "/tmp/history-repo",
            watchedSavePath: "/tmp/user1.dat",
            capturePolicy: { debounceWriteMs: 500, minCommitIntervalMs: 0 },
          });
        }
        if (url.includes("/api/v1/diff")) {
          return Response.json(
            {
              error: {
                code: "read_model_unavailable",
                message: "Semantic Diff is unavailable.",
              },
            },
            { status: 503 },
          );
        }
        if (url.includes("/api/v1/save") && url.includes("commit=")) {
          const saveUrl = new URL(url);
          const commitRef = saveUrl.searchParams.get("commit");
          if (commitRef === null) {
            throw new Error("Expected a commit-selected Save State request.");
          }
          const isUnrecognized = commitRef === "before";
          return Response.json({
            status: "available",
            observation: {
              ...latestObservation,
              commit: createCommit(commitRef),
              schema: isUnrecognized
                ? { status: "unrecognized", reason: "future-save-schema" }
                : latestObservation.schema,
            },
            decodedSave: { commit: commitRef },
            // eslint-disable-next-line unicorn/no-null -- null is the wire value for an unavailable Semantic Snapshot.
            semanticSnapshot: isUnrecognized ? null : snapshot,
          });
        }
        if (url.includes("/api/v1/save")) {
          return Response.json({ status: "empty" });
        }

        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(() => <App />);
    connectLocalHistory();
    expect(await screen.findByTestId("diff-view")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    const rawTab = await screen.findByRole("tab", { name: "Raw JSON" });
    await waitFor(() => {
      expect(rawTab.getAttribute("aria-selected")).toBe("true");
    });
    expect(screen.getByTestId("raw-save-diff-fallback").textContent).toContain(
      '"commit": "before"',
    );

    fireEvent.click(screen.getByRole("tab", { name: "Semantic" }));
    expect(
      screen.getByText(
        "Semantic Diff is unavailable because an observation uses an unrecognized schema.",
      ),
    ).toBeDefined();
    expect(screen.queryByTestId("progress-view")).toBeNull();
  });
});

function connectLocalHistory() {
  fireEvent.click(getRequiredElement("#connect-local-history"));
  fireEvent.input(getRequiredElement("#local-history-token"), {
    target: { value: "session-token" },
  });
  fireEvent.click(getRequiredElement("#local-history-connect"));
}

function createCommit(ref: string) {
  return {
    ref,
    shortRef: ref,
    committedAt: "2026-07-14T00:00:00.000Z",
  };
}

function getRequiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`Expected ${selector} to exist.`);
  }

  return element;
}

function getRequiredInput(selector: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (input === null) {
    throw new Error(`Expected ${selector} input to exist.`);
  }

  return input;
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
