export {
  DecodeEncodedSaveError,
  decodeEncodedSave,
} from "./decode/decode-encoded-save.ts";
export {
  UnrecognizedSaveSchemaError,
  parseDecodedSave,
} from "./decode/parse-decoded-save.ts";
export { getBuiltinMappingData } from "./mapping/get-builtin-mapping-data.ts";
export { createSemanticSnapshot } from "./snapshot/create-semantic-snapshot.ts";
export type {
  DecodedSave,
  MappingData,
  SaveSummaryMetrics,
  SemanticSnapshot,
  SemanticSnapshotItem,
  SemanticSnapshotItemStatus,
  SnapshotOptions,
  SourceReference,
} from "./types.ts";
