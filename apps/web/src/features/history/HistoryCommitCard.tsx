import { For, Show } from "solid-js";

import type { LocalHttpObservationHistoryResult } from "@silksong-git/repo-session/http-wire";
import buttonStyles from "../../ui/Button.module.css";
import styles from "./HistoryView.module.css";
import type { HistoryEventGroup } from "./history-events-query.ts";

type ObservationEntry = LocalHttpObservationHistoryResult["entries"][number];

export type HistoryCommitRecord =
  | { readonly group: HistoryEventGroup; readonly kind: "events" }
  | { readonly entry: ObservationEntry; readonly kind: "observation" };

export function HistoryCommitCard(props: {
  readonly canRestore?: boolean;
  readonly onCompare: (commit: string) => void;
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
  const currentSavePath = () =>
    observation()?.schema.status === "recognized" && summary() !== undefined
      ? "/progress"
      : "/raw-save";

  return (
    <Show when={commit()}>
      {(selectedCommit) => (
        <article data-testid="history-commit-card">
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
              <dl>
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
          <div class={styles["actions"]}>
            <a
              class={buttonStyles["primary"]}
              href={`${currentSavePath()}?commit=${encodeURIComponent(selectedCommit().ref)}`}
            >
              {currentSavePath() === "/progress"
                ? "View Progress"
                : "View Raw Save"}
            </a>
            <button
              class={buttonStyles["secondary"]}
              type="button"
              onClick={props.onExport}
            >
              Export
            </button>
            <Show when={props.canRestore !== false}>
              <button
                class={buttonStyles["danger"]}
                type="button"
                onClick={props.onRestore}
              >
                Restore
              </button>
            </Show>
            <button
              class={buttonStyles["secondary"]}
              type="button"
              onClick={() => {
                props.onCompare(selectedCommit().ref);
              }}
            >
              Compare
            </button>
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
