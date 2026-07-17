import { useLocation, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import buttonStyles from "../../ui/Button.module.css";
import styles from "./HistoricalSelectionBanner.module.css";
import { getQueryParam } from "./url-utils.ts";

export function HistoricalSelectionBanner() {
  const location = useLocation();
  const navigate = useNavigate();
  const localHistory = useLocalHistoryStore();
  const selectedCommit = () => getQueryParam(location.search, "commit");
  const latestCommit = () => {
    const connection = localHistory.connection();
    if (connection.kind !== "connected") {
      return undefined;
    }
    const lastObservation = connection.session.watcherStatus()?.lastObservation;
    if (lastObservation?.status === "committed") {
      return lastObservation.commit;
    }
    const latestState = connection.session.latestSaveState();

    return latestState?.status === "available"
      ? latestState.observation.commit
      : undefined;
  };
  const hasNewerLatest = () => {
    const latest = latestCommit();
    const selected = selectedCommit();

    return (
      latest !== undefined && selected !== undefined && latest.ref !== selected
    );
  };

  return (
    <Show
      when={
        localHistory.connection().kind === "connected"
        && selectedCommit() !== undefined
      }
    >
      <div
        class={styles["historical-banner"]}
        data-testid="historical-selection-banner"
      >
        <span>
          Viewing historical commit <code>{selectedCommit()}</code>
        </span>
        <Show when={hasNewerLatest()}>
          <span>A newer latest save is available.</span>
        </Show>
        <button
          class={buttonStyles["secondary"]}
          id="back-to-latest"
          type="button"
          onClick={() => {
            const params = new URLSearchParams(location.search);
            params.delete("commit");
            const suffix = params.toString();
            navigate(
              `${location.pathname}${suffix === "" ? "" : `?${suffix}`}`,
            );
          }}
        >
          Back to Latest
        </button>
      </div>
    </Show>
  );
}
