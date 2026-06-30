import type { RawSaveObservation } from "./types.ts";

export type ObservationMetadata = Omit<RawSaveObservation, "commit">;
