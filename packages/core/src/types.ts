export interface DecodedSave {
  readonly playerData: Record<string, unknown>;
  readonly sceneData?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface MappingData {
  readonly version?: string;
  readonly sections: readonly MappingSection[];
}

interface MappingSection {
  readonly id: string;
  readonly label: string;
  readonly categories: readonly MappingCategory[];
}

interface MappingCategory {
  readonly id: string;
  readonly label: string;
  readonly items: readonly MappingItem[];
}

export type MappingItem = SceneBoolMappingItem;

interface MappingItemBase {
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

interface SceneBoolMappingItem extends MappingItemBase {
  readonly type: "sceneBool";
  readonly flag: string;
  readonly scene: string;
}

export interface SnapshotOptions {
  readonly semanticCoreVersion?: string;
}

export interface SemanticSnapshot {
  readonly items: readonly SemanticSnapshotItem[];
  readonly summary: SaveSummaryMetrics;
  readonly version: {
    readonly mappingDataVersion?: string;
    readonly semanticCoreVersion?: string;
  };
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

export type SemanticSnapshotItemStatus = "done" | "missing" | "unknown";

export interface SourceReference {
  readonly kind: "sceneFlag";
  readonly scene: string;
  readonly flag: string;
}

export interface SaveSummaryMetrics {
  readonly completionPercentage?: number;
  readonly playTime?: number;
  readonly rosaries?: number;
  readonly shellShards?: number;
  readonly permadeathMode?: unknown;
}
