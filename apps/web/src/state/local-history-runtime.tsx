import { useLocation, useNavigate } from "@solidjs/router";
import { createEffect, onCleanup, untrack } from "solid-js";

import { getQueryParam } from "../features/local-history/url-utils.ts";
import { useLocalHistoryStore } from "./local-history-store.tsx";
import { useSaveStore } from "./save-store.tsx";

const watcherPollIntervalMs = 1000;

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

  createEffect(() => {
    const connection = localHistory.connection();
    if (
      connection.kind !== "connected"
      || (connection.availability.kind === "stale"
        && connection.availability.automaticRequestsPaused)
    ) {
      return;
    }

    let cancelled = false;
    let pollInFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timer === undefined) {
        return;
      }

      clearTimeout(timer);
      timer = undefined;
    };
    const schedulePoll = () => {
      clearTimer();
      if (!cancelled && document.visibilityState === "visible") {
        timer = setTimeout(pollWatcher, watcherPollIntervalMs);
      }
    };
    const pollWatcher = () => {
      if (cancelled || pollInFlight || document.visibilityState !== "visible") {
        return;
      }
      pollInFlight = true;
      connection.session.client
        .getWatcher()
        .then((status) => {
          if (cancelled) {
            return;
          }

          localHistory.updateWatcherStatus(status);
          localHistory.reportRequestSuccess();
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            localHistory.reportRequestFailure(error);
          }
        })
        .finally(() => {
          pollInFlight = false;
          schedulePoll();
        });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        pollWatcher();
      } else {
        clearTimer();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") {
      const hasWatcherStatus =
        untrack(connection.session.watcherStatus) !== undefined;
      if (hasWatcherStatus || connection.availability.kind === "stale") {
        schedulePoll();
      } else {
        pollWatcher();
      }
    }

    onCleanup(() => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  return <></>;
}
