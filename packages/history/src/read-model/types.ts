import type { SemanticSnapshot } from "@silksong-git/core";

export interface RecognizedSnapshotRecord {
  readonly commitRef: string;
  readonly observationSequence: number;
  readonly snapshotId: string;
  readonly snapshot: SemanticSnapshot;
}
