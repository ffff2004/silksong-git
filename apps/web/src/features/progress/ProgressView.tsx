import { For, createSignal } from "solid-js";

import { useSaveStore } from "../../state/save-store.tsx";
import { formatPlayTime } from "../../utils/format.ts";
import { InfoModal } from "./InfoModal.tsx";
import { ProgressLegend } from "./ProgressLegend.tsx";
import { ProgressSection } from "./ProgressSection.tsx";
import { ProgressToc } from "./ProgressToc.tsx";
import { getProgressSections } from "./progress-selectors.ts";
import type { ProgressItemData } from "./progress-types.ts";

export function ProgressView() {
  const saveStore = useSaveStore();
  const summary = () => saveStore.snapshot()?.summary;
  const sections = getProgressSections();
  const [infoItem, setInfoItem] = createSignal<ProgressItemData>();

  return (
    <>
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
    </>
  );
}
