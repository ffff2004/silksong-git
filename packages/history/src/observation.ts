import type { ObservationTrigger, RawSaveObservation } from "./types.ts";

export interface ObservationMetadata {
  readonly observedAt: string;
  readonly trigger: ObservationTrigger;
  readonly message?: string;
  readonly sourcePath: string;
  readonly encodedSha256: string;
  readonly previousCommit?: string;
  readonly decodedSha256: string;
  readonly decoderVersion: string;
  readonly schema: RawSaveObservation["schema"];
}
