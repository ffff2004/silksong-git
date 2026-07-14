import { Show } from "solid-js";

import { assetUrl } from "../../app/asset-url.ts";
import { usePreferencesStore } from "../../state/preferences-store.tsx";
import { useProgressSnapshot } from "./progress-snapshot-context.tsx";
import type { ProgressItemData } from "./progress-types.ts";

const romanActs = new Map([
  [1, "I"],
  [2, "II"],
  [3, "III"],
]);

interface ProgressItemCardProps {
  readonly item: ProgressItemData;
  readonly onOpenInfo: (item: ProgressItemData) => void;
}

export function ProgressItemCard(props: ProgressItemCardProps) {
  const progressSnapshot = useProgressSnapshot();
  const preferences = usePreferencesStore();
  const semanticItem = () => progressSnapshot.semanticItem(props.item.id);
  const isDone = () => semanticItem()?.status === "done";
  const isAccepted = () => semanticItem()?.status === "accepted";
  const isObtained = () => {
    if (
      props.item.type === "relic"
      || props.item.type === "materium"
      || props.item.type === "device"
    ) {
      return isDone() || isAccepted();
    }

    return isDone();
  };
  const isSpoilerRevealed = () =>
    preferences.showSpoilers() && !isDone() && !isAccepted();
  const shouldRevealIcon = () =>
    isSpoilerRevealed()
    || (progressSnapshot.hasSave() ? isObtained() || isAccepted() : false);
  const iconSrc = () =>
    shouldRevealIcon()
      ? resolveIconSrc(props.item.icon)
      : assetUrl("assets/icons/locked.png");

  return (
    <button
      type="button"
      class="boss"
      classList={{
        accepted: isAccepted(),
        done: isDone(),
        locked: !shouldRevealIcon(),
        unlocked: isSpoilerRevealed(),
        unobtainable:
          props.item.unobtainable === true && progressSnapshot.hasSave(),
      }}
      data-flag={getFlagLabel(props.item)}
      data-group={props.item.group}
      id={`progress-${props.item.id}`}
      onClick={() => {
        props.onOpenInfo(props.item);
      }}
    >
      <Show
        when={props.item.type === "tool" && props.item.upgradeOf !== undefined}
      >
        <span class="upgrade-icon" title="Upgrade of another tool">
          <i class="fa-solid fa-arrow-up" />
        </span>
      </Show>
      <span class={`act-label act-${props.item.act ?? 1}`}>
        ACT {romanActs.get(props.item.act ?? 1) ?? "I"}
      </span>
      <Show when={props.item.unobtainable === true}>
        <span
          class="missable-icon unobtainable-icon"
          title="Mutually exclusive item - only one of these can be obtained"
        >
          <i class="fa-solid fa-code-branch" />
        </span>
      </Show>
      <Show when={props.item.missable === true}>
        <span
          class="missable-icon"
          title="Missable item - can be permanently lost"
        >
          !
        </span>
      </Show>
      <img src={iconSrc()} alt={props.item.label} />
      <div class="title">{props.item.label}</div>
      <Show when={props.item.type === "journal"}>
        <span class="journal-counter">
          {formatJournalCounter(props.item, semanticItem()?.value)}
        </span>
      </Show>
    </button>
  );
}

function formatJournalCounter(item: ProgressItemData, value: unknown): string {
  const current = typeof value === "number" ? value : 0;
  const required =
    "required" in item && typeof item.required === "number" ? item.required : 0;

  return current >= required ? current.toString() : `${current}/${required}`;
}

function getFlagLabel(item: ProgressItemData): string | undefined {
  if (item.type === "sceneVisited" || item.type === "anyOf") {
    return undefined;
  }

  if (item.type === "key" && "flags" in item && item.flags !== undefined) {
    return item.flags.join("|");
  }

  return "flag" in item ? item.flag : undefined;
}

function resolveIconSrc(icon: string | undefined): string {
  const clean = (icon ?? "").trim();
  if (clean === "") {
    return "";
  }

  if (clean.startsWith("http")) {
    return clean;
  }

  if (clean.startsWith("assets/")) {
    return assetUrl(clean);
  }

  return assetUrl(`assets/${clean}`);
}
