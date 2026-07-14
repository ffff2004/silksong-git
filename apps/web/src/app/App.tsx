import { HashRouter, Route } from "@solidjs/router";

import { MapView } from "../features/map/MapView.tsx";
import { ProgressView } from "../features/progress/ProgressView.tsx";
import { RawSaveView } from "../features/raw-save/RawSaveView.tsx";
import { LocalHistoryProvider } from "../state/local-history-store.tsx";
import { PreferencesProvider } from "../state/preferences-store.tsx";
import { SaveProvider } from "../state/save-store.tsx";
import { ToastProvider } from "../state/toast-store.tsx";
import { AppShell } from "./AppShell.tsx";

export function App() {
  return (
    <ToastProvider>
      <PreferencesProvider>
        <SaveProvider>
          <LocalHistoryProvider>
            <HashRouter root={AppShell}>
              <Route path="/" component={ProgressView} />
              <Route path="/progress" component={ProgressView} />
              <Route path="/map" component={MapView} />
              <Route path="/raw-save" component={RawSaveView} />
              <Route path="*404" component={ProgressView} />
            </HashRouter>
          </LocalHistoryProvider>
        </SaveProvider>
      </PreferencesProvider>
    </ToastProvider>
  );
}
