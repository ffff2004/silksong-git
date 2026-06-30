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
