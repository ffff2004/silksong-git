import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, onCleanup } from "solid-js";

import { getQueryParam } from "../features/local-history/url-utils.ts";
import { useLocalHistoryStore } from "./local-history-store.tsx";
import { useSaveStore } from "./save-store.tsx";

/** Coordinates Local History I/O without becoming another source of save state. */
export function LocalHistoryRuntime() {
  const localHistory = useLocalHistoryStore();
  const saveStore = useSaveStore();
  const navigate = useNavigate();
  const location = useLocation();
  let hadLocalSession = false;

  createEffect(() => {
    const connection = localHistory.connection();
    if (connection.kind === "connected") {
      hadLocalSession = true;
      if (connection.availability.kind === "stale") {
        return;
      }
      const commit = getQueryParam(location.search, "commit");
      let cancelled = false;
      connection.session.client
        .getSave(
          commit === undefined
            ? { kind: "latest" }
            : { commitRef: commit, kind: "commit" },
        )
        .then((state) => {
          if (!cancelled) {
            saveStore.loadLocalState(
              state,
              commit === undefined
                ? undefined
                : { commit, kind: "localCommit" },
            );
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            localHistory.reportRequestFailure(error);
          }
        });

      onCleanup(() => {
        cancelled = true;
      });
      return;
    }

    if (connection.kind === "disconnected" && hadLocalSession) {
      hadLocalSession = false;
      saveStore.clear();
      navigate("/progress");
    }
  });

  return <></>;
}
