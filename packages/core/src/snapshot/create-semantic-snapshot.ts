import type { MappingData } from "../mapping/mapping-types.ts";
import type {
  ParsedDecodedSave,
  SemanticSnapshot,
  SemanticSnapshotItem,
  SnapshotOptions,
} from "../types.ts";
import { createSnapshotCreationContext } from "./snapshot-creation-context.ts";
import { createSnapshotItem } from "./snapshot-items.ts";
import { createSummaryMetrics } from "./summary-metrics.ts";

const semanticCoreVersion = "core-semantic-v1";

export function createSemanticSnapshot(
  parsedSave: ParsedDecodedSave,
  mappingData: MappingData,
  options: SnapshotOptions = {},
): SemanticSnapshot {
  const items: SemanticSnapshotItem[] = [];
  const { decodedSave } = parsedSave;
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
      saveSchemaVersion: parsedSave.version.saveSchemaVersion,
      gameVersion: parsedSave.version.gameVersion,
      platform: parsedSave.version.platform,
      platformBuildId: parsedSave.version.platformBuildId,
      mappingDataVersion: mappingData.version,
      semanticCoreVersion,
      configHash: options.configHash,
    },
  };
}
