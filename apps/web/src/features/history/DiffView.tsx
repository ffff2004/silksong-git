import { useNavigate } from "@solidjs/router";
import { createSignal, onMount, Show } from "solid-js";

import type { LocalHttpDiffResult } from "@silksong-git/history/http-wire";
import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import { LocalRoute } from "../local-history/LocalRoute.tsx";
import { ProgressSnapshotView } from "../progress/ProgressSnapshotView.tsx";
import { MonacoJsonDiffViewer } from "../raw-save/MonacoJsonDiffViewer.tsx";

export function DiffRoute() {
  return (
    <LocalRoute>
      <DiffView />
    </LocalRoute>
  );
}

function DiffView() {
  const localHistory = useLocalHistoryStore();
  const navigate = useNavigate();
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const [view, setView] = createSignal<"raw" | "semantic">("semantic");
  const [diff, setDiff] = createSignal<LocalHttpDiffResult>();
  const [rawDiff, setRawDiff] = createSignal<{
    readonly fromValue: string;
    readonly toValue: string;
  }>();
  const [rawError, setRawError] = createSignal<string>();
  const [semanticError, setSemanticError] = createSignal<string>();

  onMount(() => {
    const params = new URLSearchParams(
      globalThis.location.hash.split("?", 2)[1] ?? "",
    );
    setFrom(params.get("from") ?? "");
    setTo(params.get("to") ?? "");
  });

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const connection = localHistory.connection();
    if (connection.kind !== "connected" || from() === "" || to() === "") {
      return;
    }
    const fromRef = from();
    const toRef = to();
    navigate(
      `/diff?from=${encodeURIComponent(fromRef)}&to=${encodeURIComponent(toRef)}`,
    );
    setDiff(undefined);
    setRawDiff(undefined);
    setRawError(undefined);
    setSemanticError(undefined);
    setView("semantic");

    const [semanticResult, fromSaveResult, toSaveResult] =
      await Promise.allSettled([
        connection.session.client.getDiff({
          from: fromRef,
          to: toRef,
        }),
        connection.session.client.getSave({
          commitRef: fromRef,
          kind: "commit",
        }),
        connection.session.client.getSave({
          commitRef: toRef,
          kind: "commit",
        }),
      ]);

    if (semanticResult.status === "fulfilled") {
      setDiff(semanticResult.value);
    } else {
      setSemanticError(toErrorMessage(semanticResult.reason, "Semantic Diff"));
    }

    if (
      fromSaveResult.status === "fulfilled"
      && toSaveResult.status === "fulfilled"
      && fromSaveResult.value.status === "available"
      && toSaveResult.value.status === "available"
    ) {
      const hasUnrecognizedSchema = [
        fromSaveResult.value,
        toSaveResult.value,
      ].some(
        (save) =>
          save.semanticSnapshot === null
          || save.observation.schema.status === "unrecognized",
      );
      setRawDiff({
        fromValue: stringifyDecodedSave(fromSaveResult.value.decodedSave),
        toValue: stringifyDecodedSave(toSaveResult.value.decodedSave),
      });
      if (hasUnrecognizedSchema) {
        setDiff(undefined);
        setSemanticError(
          "Semantic Diff is unavailable because an observation uses an unrecognized schema.",
        );
        setView("raw");
      }
    } else {
      const rejectedSave = [fromSaveResult, toSaveResult].find(
        (result) => result.status === "rejected",
      );
      setRawError(
        rejectedSave?.status === "rejected"
          ? toErrorMessage(rejectedSave.reason, "Decoded Save JSON comparison")
          : "Decoded Save JSON is unavailable for this diff.",
      );
    }
  };

  const handleSubmit = (event: SubmitEvent) => {
    submit(event).catch((error_: unknown) => {
      setSemanticError(toErrorMessage(error_, "Diff"));
    });
  };

  return (
    <section class="tab" data-testid="diff-view">
      <h2>Compare Saves</h2>
      <form onSubmit={handleSubmit}>
        <label>
          From{" "}
          <input
            id="diff-from"
            value={from()}
            onInput={(event) => {
              setFrom(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            id="diff-to"
            value={to()}
            onInput={(event) => {
              setTo(event.currentTarget.value);
            }}
          />
        </label>
        <button class="btn-primary" type="submit">
          Compare
        </button>
      </form>
      <Show
        when={
          diff() !== undefined
          || rawDiff() !== undefined
          || semanticError() !== undefined
          || rawError() !== undefined
        }
      >
        <div class="local-history-tabs" role="tablist" aria-label="Diff view">
          <button
            class="btn-reset"
            classList={{ active: view() === "semantic" }}
            type="button"
            role="tab"
            aria-selected={view() === "semantic"}
            onClick={() => {
              setView("semantic");
            }}
          >
            Semantic
          </button>
          <button
            class="btn-reset"
            classList={{ active: view() === "raw" }}
            type="button"
            role="tab"
            aria-selected={view() === "raw"}
            onClick={() => {
              setView("raw");
            }}
          >
            Raw JSON
          </button>
        </div>
        <Show when={view() === "semantic"}>
          <Show when={semanticError()}>
            {(message) => <p role="alert">{message()}</p>}
          </Show>
          <Show when={diff()}>
            {(value) => (
              <ProgressSnapshotView
                presentation={{
                  before: value().before,
                  events: value().events.map((entry) => entry.event),
                  kind: "comparison",
                }}
                snapshot={value().after}
              />
            )}
          </Show>
        </Show>
        <Show when={view() === "raw"}>
          <Show when={rawError()}>
            {(message) => <p role="alert">{message()}</p>}
          </Show>
          <Show when={rawDiff()}>
            {(rawValue) => (
              <MonacoJsonDiffViewer
                fromValue={rawValue().fromValue}
                toValue={rawValue().toValue}
              />
            )}
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function stringifyDecodedSave(decodedSave: unknown): string {
  return JSON.stringify(decodedSave, undefined, 2);
}

function toErrorMessage(error: unknown, source: string): string {
  return error instanceof Error
    ? error.message
    : `${source} is unavailable for this diff.`;
}
