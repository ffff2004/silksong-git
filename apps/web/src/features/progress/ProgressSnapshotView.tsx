import type { SemanticSnapshot } from "@silksong-git/core";
import { For, createSignal } from "solid-js";

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

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the CSS Module key is defined beside this component.
const progressDiffToolbarClass = styles["progressDiffToolbar"]!;

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
      <section id="allprogress-section" class="tab" data-testid="progress-view">
        <h2>All Progress</h2>
        {props.presentation?.kind === "comparison" && (
          <div class={progressDiffToolbarClass}>
            <button
              class="btn-reset"
              type="button"
              onClick={() => {
                setShowUnchanged((value) => !value);
              }}
            >
              {showUnchanged() ? "Hide unchanged" : "Show unchanged"}
            </button>
          </div>
        )}
        <div id="main-stats" class="main-stats">
          <div class="completion">
            <span class="label">Completion:</span>
            <span id="completionValue">
              {summary()?.completionPercentage ?? 0}%
            </span>
          </div>
          <div class="playtime">
            <span class="label">Play Time:</span>
            <span id="playtimeValue">
              {formatPlayTime(summary()?.playTime ?? 0)}
            </span>
          </div>
          <div class="rosaries">
            <span class="label">Rosaries:</span>
            <span id="rosariesValue">{summary()?.rosaries ?? 0}</span>
          </div>
          <div class="shards">
            <span class="label">Shell Shards:</span>
            <span id="shardsValue">{summary()?.shellShards ?? 0}</span>
          </div>
        </div>
        <div id="allprogress-grid">
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
        <ProgressLegend />
      </section>
      <ProgressToc sections={sections} />
      <InfoModal
        item={infoItem()}
        onClose={() => {
          setInfoItem(undefined);
        }}
      />
    </ProgressSnapshotProvider>
  );
}
