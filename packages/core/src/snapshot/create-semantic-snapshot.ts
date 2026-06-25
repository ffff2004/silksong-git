import type {
  DecodedSave,
  MappingData,
  SemanticSnapshot,
  SemanticSnapshotItem,
  SnapshotOptions,
} from "../types.ts";
import { createSnapshotCreationContext } from "./snapshot-creation-context.ts";
import { createSnapshotItem } from "./snapshot-items.ts";
import { createSummaryMetrics } from "./summary-metrics.ts";

export function createSemanticSnapshot(
  decodedSave: DecodedSave,
  mappingData: MappingData,
  options: SnapshotOptions = {},
): SemanticSnapshot {
  const items: SemanticSnapshotItem[] = [];
  const context = createSnapshotCreationContext(decodedSave);

  for (const section of mappingData.sections) {
    for (const category of section.categories) {
      for (const item of category.items) {
        items.push(createSnapshotItem(context, item, section.id, category.id));
      }
    }
  }

  return {
    items,
    summary: createSummaryMetrics(decodedSave),
    version: {
      saveSchemaVersion: options.saveSchemaVersion,
      gameVersion: options.gameVersion,
      platform: options.platform,
      platformBuildId: options.platformBuildId,
      mappingDataVersion: mappingData.version,
      semanticCoreVersion: options.semanticCoreVersion,
      configHash: options.configHash,
    },
  };
}
