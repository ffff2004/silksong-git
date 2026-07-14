import { useLocation, useNavigate } from "@solidjs/router";
import { Show } from "solid-js";

import { useLocalHistoryStore } from "../../state/local-history-store.tsx";
import styles from "./SaveBanner.module.css";
import { getQueryParam } from "./url-utils.ts";

export function HistoricalSelectionBanner() {
  const location = useLocation();
  const navigate = useNavigate();
  const localHistory = useLocalHistoryStore();
  const selectedCommit = () => getQueryParam(location.search, "commit");

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
        <button
          class="btn-reset"
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
