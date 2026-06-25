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

export type MappingItem =
  | SceneBoolMappingItem
  | DirectPlayerDataBooleanMappingItem
  | KeyMappingItem
  | NumericThresholdMappingItem
  | SavedDataMappingItem
  | QuestMappingItem
  | JournalMappingItem
  | RelicMappingItem
  | MateriumMappingItem
  | DeviceMappingItem
  | SceneVisitedMappingItem
  | QuillMappingItem
  | AnyOfMappingItem;

interface MappingItemBase {
  readonly id: string;
  readonly label: string;
  readonly type: string;
}

interface SceneBoolMappingItem extends MappingItemBase {
  readonly type: "sceneBool";
  readonly flag: string;
  readonly required?: number;
  readonly scene: string;
}

interface DirectPlayerDataBooleanMappingItem extends MappingItemBase {
  readonly type: "flag" | "boss";
  readonly flag: string;
}

interface KeyMappingItem extends MappingItemBase {
  readonly type: "key";
  readonly flag?: string;
  readonly flags?: readonly string[];
}

interface NumericThresholdMappingItem extends MappingItemBase {
  readonly type: "level" | "flagInt";
  readonly flag: string;
  readonly required?: number;
}

interface SavedDataMappingItem extends MappingItemBase {
  readonly type: "collectable" | "tool";
  readonly flag: string;
}

interface QuestMappingItem extends MappingItemBase {
  readonly type: "quest";
  readonly flag: string;
}

interface JournalMappingItem extends MappingItemBase {
  readonly type: "journal";
  readonly flag: string;
  readonly required: number;
}

interface RelicMappingItem extends MappingItemBase {
  readonly type: "relic";
  readonly flag: string;
}

interface MateriumMappingItem extends MappingItemBase {
  readonly type: "materium";
  readonly flag: string;
}

interface DeviceMappingItem extends MappingItemBase {
  readonly type: "device";
  readonly flag: string;
  readonly relatedFlag: string;
  readonly scene: string;
}

interface SceneVisitedMappingItem extends MappingItemBase {
  readonly type: "sceneVisited";
  readonly scene: string;
}

interface QuillMappingItem extends MappingItemBase {
  readonly type: "quill";
  readonly flag: string;
}

interface AnyOfMappingItem extends MappingItemBase {
  readonly type: "anyOf";
  readonly anyOf: readonly MappingItemCheck[];
}

export type MappingItemCheck =
  | FlagMappingItemCheck
  | FlagIntMappingItemCheck
  | LevelMappingItemCheck
  | SceneBoolMappingItemCheck
  | SceneVisitedMappingItemCheck;

interface FlagMappingItemCheck {
  readonly type: "flag";
  readonly flag: string;
}

interface FlagIntMappingItemCheck {
  readonly type: "flagInt";
  readonly flag: string;
}

interface LevelMappingItemCheck {
  readonly type: "level";
  readonly flag: string;
  readonly required: number;
}

interface SceneBoolMappingItemCheck {
  readonly type: "sceneBool";
  readonly flag: string;
  readonly scene: string;
}

interface SceneVisitedMappingItemCheck {
  readonly type: "sceneVisited";
  readonly scene: string;
}

export interface SnapshotOptions {
  readonly saveSchemaVersion?: string;
  readonly gameVersion?: string;
  readonly platform?: string;
  readonly platformBuildId?: string;
  readonly semanticCoreVersion?: string;
  readonly configHash?: string;
}

export interface SemanticSnapshot {
  readonly items: readonly SemanticSnapshotItem[];
  readonly summary: SaveSummaryMetrics;
  readonly version: SemanticSnapshotVersion;
}

interface SemanticSnapshotVersion {
  readonly saveSchemaVersion?: string;
  readonly gameVersion?: string;
  readonly platform?: string;
  readonly platformBuildId?: string;
  readonly mappingDataVersion?: string;
  readonly semanticCoreVersion?: string;
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
