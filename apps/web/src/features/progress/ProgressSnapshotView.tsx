import type { SemanticSnapshot } from "@silksong-git/core";
import { For, createSignal } from "solid-js";

import buttonStyles from "../../ui/Button.module.css";
import viewStyles from "../../ui/View.module.css";
import { formatPlayTime } from "../../utils/format.ts";
import { InfoModal } from "./InfoModal.tsx";
import { getProgressSections } from "./progress-selectors.ts";
import type { ProgressSnapshotPresentation } from "./progress-snapshot-context.tsx";
import { ProgressSnapshotProvider } from "./progress-snapshot-context.tsx";
import type { ProgressItemData } from "./progress-types.ts";
import { ProgressLegend } from "./ProgressLegend.tsx";
import { ProgressSection } from "./ProgressSection.tsx";
import styles from "./ProgressSnapshotView.module.css";
import { ProgressToc } from "./ProgressToc.tsx";

const progressDiffToolbarClass = styles["progressDiffToolbar"]!;
const progressContentClass = styles["progressContent"]!;
const progressLayoutClass = styles["progressLayout"]!;

interface ProgressSnapshotViewProps {
  readonly presentation?: ProgressSnapshotPresentation;
  readonly snapshot: SemanticSnapshot | undefined;
}

export function ProgressSnapshotView(props: ProgressSnapshotViewProps) {
  const sections = getProgressSections();
  const [infoItem, setInfoItem] = createSignal<ProgressItemData>();
  const [showUnchanged, setShowUnchanged] = createSignal(
    props.presentation?.kind !== "comparison",
  );
  const summary = () => props.snapshot?.summary;

  return (
    <ProgressSnapshotProvider
      presentation={props.presentation}
      showUnchanged={showUnchanged}
      snapshot={props.snapshot}
    >
      <div class={progressLayoutClass} data-testid="progress-layout">
        <section
          id="allprogress-section"
          class={`${viewStyles["view"]} ${progressContentClass}`}
          data-testid="progress-view"
        >
          <h2 class={styles["pageHeading"]}>All Progress</h2>
          {props.presentation?.kind === "comparison" && (
            <div class={progressDiffToolbarClass}>
              <button
                class={buttonStyles["secondary"]}
                type="button"
                onClick={() => {
                  setShowUnchanged((value) => !value);
                }}
              >
                {showUnchanged() ? "Hide unchanged" : "Show unchanged"}
              </button>
            </div>
          )}
          <div id="main-stats" class={styles["stats"]}>
            <div>
              <span class={styles["statsLabel"]}>Completion:</span>
              <span id="completionValue">
                {summary()?.completionPercentage ?? 0}%
              </span>
            </div>
            <div>
              <span class={styles["statsLabel"]}>Play Time:</span>
              <span id="playtimeValue">
                {formatPlayTime(summary()?.playTime ?? 0)}
              </span>
            </div>
            <div>
              <span class={styles["statsLabel"]}>Rosaries:</span>
              <span id="rosariesValue">{summary()?.rosaries ?? 0}</span>
            </div>
            <div>
              <span class={styles["statsLabel"]}>Shell Shards:</span>
              <span id="shardsValue">{summary()?.shellShards ?? 0}</span>
            </div>
          </div>
          <div id="allprogress-grid" class={styles["sections"]}>
            <For each={sections}>
              {(section) => (
                <ProgressSection
                  section={section}
                  onOpenInfo={(item) => {
                    setInfoItem(item);
                  }}
                />
              )}
            </For>
          </div>
          <div class={styles["legendSlot"]}>
            <ProgressLegend />
          </div>
        </section>
        <div class={styles["tocSlot"]} data-progress-toc-slot>
          <ProgressToc sections={sections} />
        </div>
      </div>
      <InfoModal
        item={infoItem()}
        onClose={() => {
          setInfoItem(undefined);
        }}
      />
    </ProgressSnapshotProvider>
  );
}
