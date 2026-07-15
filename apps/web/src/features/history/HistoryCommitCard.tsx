import { For, Show } from "solid-js";

import type { LocalHttpObservationHistoryResult } from "@silksong-git/history/http-wire";
import type { HistoryEventGroup } from "./history-events-query.ts";

type ObservationEntry = LocalHttpObservationHistoryResult["entries"][number];

export type HistoryCommitRecord =
  | { readonly group: HistoryEventGroup; readonly kind: "events" }
  | { readonly entry: ObservationEntry; readonly kind: "observation" };

export function HistoryCommitCard(props: {
  readonly onExport: () => void;
  readonly onRestore: () => void;
  readonly record: HistoryCommitRecord;
}) {
  const firstEvent = () =>
    props.record.kind === "events" ? props.record.group.events[0] : undefined;
  const observation = () =>
    props.record.kind === "events"
      ? firstEvent()?.observation
      : props.record.entry.observation;
  const commit = () => observation()?.commit;
  const summary = () =>
    props.record.kind === "events"
      ? firstEvent()?.snapshotSummary
      : (props.record.entry.snapshotSummary ?? undefined);
  const previousCommit = () =>
    props.record.kind === "events"
      ? firstEvent()?.previousCommit?.ref
      : props.record.entry.observation.previousCommit;
  const currentSavePath = () =>
    observation()?.schema.status === "recognized" && summary() !== undefined
      ? "/progress"
      : "/raw-save";

  return (
    <Show when={commit()}>
      {(selectedCommit) => (
        <article class="history-card" data-testid="history-commit-card">
          <header>
            <strong>{selectedCommit().shortRef}</strong>
            <time>{selectedCommit().committedAt}</time>
          </header>
          <p>
            {observation()?.schema.status === "recognized"
              ? "Recognized schema"
              : "Unrecognized schema"}
          </p>
          <Show when={summary()} fallback={<p>Summary unavailable.</p>}>
            {(metrics) => (
              <dl class="save-summary-metrics">
                <div>
                  <dt>Completion</dt>
                  <dd>{metrics().completionPercentage ?? 0}%</dd>
                </div>
                <div>
                  <dt>Play Time</dt>
                  <dd>{metrics().playTime ?? 0}</dd>
                </div>
                <div>
                  <dt>Rosaries</dt>
                  <dd>{metrics().rosaries ?? 0}</dd>
                </div>
                <div>
                  <dt>Shell Shards</dt>
                  <dd>{metrics().shellShards ?? 0}</dd>
                </div>
              </dl>
            )}
          </Show>
          <div class="history-actions">
            <a
              class="btn-primary"
              href={`${currentSavePath()}?commit=${encodeURIComponent(selectedCommit().ref)}`}
            >
              {currentSavePath() === "/progress"
                ? "View Progress"
                : "View Raw Save"}
            </a>
            <button class="btn-reset" type="button" onClick={props.onExport}>
              Export
            </button>
            <button class="btn-reset" type="button" onClick={props.onRestore}>
              Restore
            </button>
            <a
              class="btn-reset"
              href={`/diff?from=${encodeURIComponent(previousCommit() ?? selectedCommit().ref)}&to=${encodeURIComponent(selectedCommit().ref)}`}
            >
              Compare
            </a>
          </div>
          <Show when={props.record.kind === "events"}>
            <ul>
              <For
                each={
                  props.record.kind === "events"
                    ? props.record.group.events
                    : []
                }
              >
                {(event) => (
                  <li data-testid="history-event-row">
                    {event.event.kind === "item"
                      ? event.event.item.label
                      : event.event.metric}
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </article>
      )}
    </Show>
  );
}
