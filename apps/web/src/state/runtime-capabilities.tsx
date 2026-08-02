import type { JSX } from "solid-js";
import { createContext, useContext } from "solid-js";

import type { RuntimeCapabilities } from "../runtime-capabilities/interface.ts";

const RuntimeCapabilitiesContext = createContext<RuntimeCapabilities>();

export function RuntimeCapabilitiesProvider(props: {
  readonly children: JSX.Element;
  readonly runtimeCapabilities: RuntimeCapabilities;
}) {
  return (
    <RuntimeCapabilitiesContext.Provider value={props.runtimeCapabilities}>
      {props.children}
    </RuntimeCapabilitiesContext.Provider>
  );
}

export function useRuntimeCapabilities(): RuntimeCapabilities {
  const capabilities = useContext(RuntimeCapabilitiesContext);
  if (capabilities === undefined) {
    throw new Error("Runtime capabilities are not available.");
  }
  return capabilities;
}
