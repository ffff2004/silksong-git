import { isArray } from "complete-common";
import type { JSX } from "solid-js";
import {
  createContext,
  createEffect,
  createSignal,
  onMount,
  useContext,
} from "solid-js";

interface PreferencesStore {
  readonly progressLegendCollapsed: () => boolean;
  readonly selectedActs: () => readonly number[];
  readonly setProgressLegendCollapsed: (collapsed: boolean) => void;
  readonly setSelectedActs: (acts: readonly number[]) => void;
  readonly setShowOnlyMissing: (showOnlyMissing: boolean) => void;
  readonly setShowSpoilers: (showSpoilers: boolean) => void;
  readonly showOnlyMissing: () => boolean;
  readonly showSpoilers: () => boolean;
}

const PreferencesContext = createContext<PreferencesStore>();
const defaultActs = [1, 2, 3] as const;

export function PreferencesProvider(props: { readonly children: JSX.Element }) {
  const [selectedActs, setSelectedActsSignal] =
    createSignal<readonly number[]>(defaultActs);
  const [showOnlyMissing, setShowOnlyMissing] = createSignal(false);
  const [showSpoilers, setShowSpoilers] = createSignal(false);
  const [progressLegendCollapsed, setProgressLegendCollapsed] = createSignal(
    readStoredBoolean("progressLegendCollapsed"),
  );
  let hydrated = false;

  onMount(() => {
    setSelectedActsSignal(readStoredActs());
    setShowOnlyMissing(localStorage.getItem("showOnlyMissing") === "true");
    setShowSpoilers(localStorage.getItem("showSpoilers") === "true");
    setProgressLegendCollapsed(
      localStorage.getItem("progressLegendCollapsed") === "true",
    );
    hydrated = true;
  });

  createEffect(() => {
    document.body.classList.toggle("spoiler-on", !showSpoilers());

    if (!hydrated) {
      return;
    }

    localStorage.setItem("actsDropdown", JSON.stringify(selectedActs()));
    localStorage.setItem("showOnlyMissing", showOnlyMissing().toString());
    localStorage.setItem("showSpoilers", showSpoilers().toString());
    localStorage.setItem(
      "progressLegendCollapsed",
      progressLegendCollapsed().toString(),
    );
  });

  const store: PreferencesStore = {
    progressLegendCollapsed,
    selectedActs: () => selectedActs(),
    setProgressLegendCollapsed(nextCollapsed) {
      setProgressLegendCollapsed(nextCollapsed);
    },
    setSelectedActs(acts) {
      const nextActs = acts.filter((act) => defaultActs.includes(act as never));
      setSelectedActsSignal(nextActs.length === 0 ? [1] : nextActs);
    },
    setShowOnlyMissing(nextShowOnlyMissing) {
      setShowOnlyMissing(nextShowOnlyMissing);
    },
    setShowSpoilers(nextShowSpoilers) {
      setShowSpoilers(nextShowSpoilers);
    },
    showOnlyMissing,
    showSpoilers,
  };

  return (
    <PreferencesContext.Provider value={store}>
      {props.children}
    </PreferencesContext.Provider>
  );
}

function readStoredBoolean(key: string): boolean {
  return localStorage.getItem(key) === "true";
}

function readStoredActs(): readonly number[] {
  const storedValue = localStorage.getItem("actsDropdown");
  if (storedValue === null) {
    return defaultActs;
  }

  try {
    const value: unknown = JSON.parse(storedValue);
    if (!isArray(value)) {
      return defaultActs;
    }

    const acts = value.filter(
      (act): act is number =>
        typeof act === "number" && defaultActs.includes(act as never),
    );

    return acts.length === 0 ? [1] : acts;
  } catch {
    return defaultActs;
  }
}

export function usePreferencesStore(): PreferencesStore {
  const store = useContext(PreferencesContext);
  if (store === undefined) {
    throw new Error("Preferences store is not available.");
  }

  return store;
}
