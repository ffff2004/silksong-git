import type { SemanticSnapshot } from "@silksong-git/core";
import { For, createSignal } from "solid-js";

import { formatPlayTime } from "../../utils/format.ts";
import { InfoModal } from "./InfoModal.tsx";
import { ProgressLegend } from "./ProgressLegend.tsx";
import { ProgressSection } from "./ProgressSection.tsx";
import { ProgressToc } from "./ProgressToc.tsx";
import { getProgressSections } from "./progress-selectors.ts";
import { ProgressSnapshotProvider } from "./progress-snapshot-context.tsx";
import type { ProgressItemData } from "./progress-types.ts";

interface ProgressSnapshotViewProps {
  readonly snapshot: SemanticSnapshot | undefined;
}

export function ProgressSnapshotView(props: ProgressSnapshotViewProps) {
  const sections = getProgressSections();
  const [infoItem, setInfoItem] = createSignal<ProgressItemData>();
  const summary = () => props.snapshot?.summary;

  return (
    <ProgressSnapshotProvider snapshot={props.snapshot}>
      <section id="allprogress-section" class="tab" data-testid="progress-view">
        <h2>All Progress</h2>
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
