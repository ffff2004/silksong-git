import { HashRouter, Route } from "@solidjs/router";

import { DiffRoute } from "../features/history/DiffView.tsx";
import { HistoryRoute } from "../features/history/HistoryView.tsx";
import { CurrentSaveRoute } from "../features/local-history/LocalRoute.tsx";
import { MapView } from "../features/map/MapView.tsx";
import { ProgressView } from "../features/progress/ProgressView.tsx";
import { RawSaveView } from "../features/raw-save/RawSaveView.tsx";
import { WatcherRoute } from "../features/watcher/WatcherView.tsx";
import type { RuntimeCapabilities } from "../runtime-capabilities/interface.ts";
import { LocalHistoryProvider } from "../state/local-history-store.tsx";
import { PreferencesProvider } from "../state/preferences-store.tsx";
import { SaveProvider } from "../state/save-store.tsx";
import { ToastProvider } from "../state/toast-store.tsx";
import { AppShell } from "./AppShell.tsx";

export function App(props: {
  readonly runtimeCapabilities: RuntimeCapabilities;
}) {
  return (
    <ToastProvider>
      <PreferencesProvider>
        <SaveProvider>
          <LocalHistoryProvider runtimeCapabilities={props.runtimeCapabilities}>
            <HashRouter root={AppShell}>
              <Route
                path="/"
                component={() => (
                  <CurrentSaveRoute>
                    <ProgressView />
                  </CurrentSaveRoute>
                )}
              />
              <Route
                path="/progress"
                component={() => (
                  <CurrentSaveRoute>
                    <ProgressView />
                  </CurrentSaveRoute>
                )}
              />
              <Route
                path="/map"
                component={() => (
                  <CurrentSaveRoute>
                    <MapView />
                  </CurrentSaveRoute>
                )}
              />
              <Route
                path="/raw-save"
                component={() => (
                  <CurrentSaveRoute>
                    <RawSaveView />
                  </CurrentSaveRoute>
                )}
              />
              <Route path="/history" component={HistoryRoute} />
              <Route path="/diff" component={DiffRoute} />
              <Route path="/watcher" component={WatcherRoute} />
              <Route path="*404" component={ProgressView} />
            </HashRouter>
          </LocalHistoryProvider>
        </SaveProvider>
      </PreferencesProvider>
    </ToastProvider>
  );
}
