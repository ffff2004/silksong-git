export interface DecodedSave {
  readonly playerData: Record<string, unknown>;
  readonly sceneData?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface DecodedEncodedSave {
  readonly decodedSave: unknown;
  readonly version: DecodedSaveDecoderVersion;
}

export interface DecodedSaveDecoderVersion {
  readonly decoderVersion: string;
}

export interface ParsedDecodedSave {
  readonly decodedSave: DecodedSave;
  readonly version: DecodedSaveVersion;
}

export interface DecodedSaveVersion {
  readonly saveSchemaVersion: string;
  readonly gameVersion?: string;
  readonly platform?: string;
  readonly platformBuildId?: string;
}

export interface SnapshotOptions {
  readonly configHash?: string;
}

export interface SemanticSnapshot {
  readonly items: readonly SemanticSnapshotItem[];
  readonly summary: SaveSummaryMetrics;
  readonly version: SemanticSnapshotVersion;
}

export interface SemanticSnapshotVersion {
  readonly saveSchemaVersion: string;
  readonly gameVersion?: string;
  readonly platform?: string;
  readonly platformBuildId?: string;
  readonly mappingDataVersion?: string;
  readonly semanticCoreVersion: string;
  readonly configHash?: string;
}

export interface SemanticSnapshotItem {
  readonly id: string;
  readonly label: string;
  readonly sectionId: string;
  readonly categoryId: string;
  readonly type: string;
  readonly status: SemanticSnapshotItemStatus;
  readonly value: unknown;
  readonly sourceReferences: readonly SourceReference[];
}

export type SemanticSnapshotItemStatus =
  | "accepted"
  | "done"
  | "missing"
  | "unknown";

export interface SemanticEventVersion {
  readonly before: SemanticSnapshotVersion;
  readonly after: SemanticSnapshotVersion;
}

export type SemanticEvent = SemanticItemEvent | SemanticSummaryMetricEvent;

export interface SemanticItemEvent {
  readonly kind: "item";
  readonly eventType: "itemStatusChanged" | "itemValueChanged";
  readonly item: SemanticEventItem;
  readonly before: SemanticItemEventState;
  readonly after: SemanticItemEventState;
  readonly direction: SemanticEventDirection;
  readonly isRegression: boolean;
  readonly sourceReferences: readonly SourceReference[];
  readonly version: SemanticEventVersion;
}

export interface SemanticEventItem {
  readonly id: string;
  readonly label: string;
  readonly sectionId: string;
  readonly categoryId: string;
  readonly type: string;
}

export interface SemanticItemEventState {
  readonly status: SemanticSnapshotItemStatus;
  readonly value: unknown;
}

export type SemanticEventDirection = "neutral" | "progression" | "regression";

export interface SemanticSummaryMetricEvent {
  readonly kind: "summaryMetric";
  readonly eventType: "summaryMetricChanged";
  readonly metric: SaveSummaryMetricName;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly direction: SemanticEventDirection;
  readonly isRegression: boolean;
  readonly sourceReferences: readonly SourceReference[];
  readonly version: SemanticEventVersion;
}

export type SaveSummaryMetricName = keyof SaveSummaryMetrics;

export type SourceReference =
  | SceneFlagSourceReference
  | PlayerDataSourceReference
  | SavedDataSourceReference;

interface SceneFlagSourceReference {
  readonly kind: "sceneFlag";
  readonly scene: string;
  readonly flag: string;
}

interface PlayerDataSourceReference {
  readonly kind: "playerData";
  readonly field: string;
}

interface SavedDataSourceReference {
  readonly kind: "savedData";
  readonly field: string;
  readonly name: string;
}

export interface SaveSummaryMetrics {
  readonly completionPercentage?: number;
  readonly playTime?: number;
  readonly rosaries?: number;
  readonly shellShards?: number;
  readonly permadeathMode?: unknown;
}
