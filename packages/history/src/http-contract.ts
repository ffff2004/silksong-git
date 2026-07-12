import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SemanticEvent, SemanticSnapshot } from "@silksong-git/core";

import type {
  DiffCommitsResult,
  GetSaveStateResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  LocalHistoryWatcherStatus,
  ObserveSaveResult,
  RawObservationHistoryResult,
  RawSaveObservation,
  RestoreEncodedSaveResult,
  SearchSemanticEventsResult,
} from "./types.ts";

export interface LocalHttpMeta {
  readonly api: {
    readonly name: "silksong-git-local-history";
    readonly version: { readonly major: 1; readonly minor: 0 };
  };
  readonly repoPath: string;
  readonly watchedSavePath: string;
  readonly capabilities: readonly LocalHttpCapability[];
}

export const localHttpCapabilities = [
  "watcherStatus",
  "saveState",
  "history",
  "rawObservations",
  "diff",
  "search",
  "checkpoint",
  "exportEncodedSave",
  "restoreInPlace",
] as const;

export type LocalHttpCapability = (typeof localHttpCapabilities)[number];

export const localHttpErrorCodes = [
  "invalid_request",
  "unauthorized",
  "route_not_found",
  "commit_not_found",
  "observation_not_found",
  "method_not_allowed",
  "request_timeout",
  "repository_busy",
  "restore_conflict",
  "payload_too_large",
  "unsupported_media_type",
  "save_decode_failed",
  "restore_configuration_invalid",
  "restore_backup_failed",
  "restore_write_failed",
  "restore_verification_failed",
  "internal_error",
  "watched_save_unavailable",
  "read_model_unavailable",
] as const;

export type LocalHttpErrorCode = (typeof localHttpErrorCodes)[number];

export const refSchema = z.string().min(1).max(1024);
export const cursorSchema = z.string().min(1).max(4096);
export const textSchema = z.string().min(1).max(1000);
export const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export const paginationSchema = {
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: cursorSchema.optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
} as const;
export const saveQuerySchema = z
  .object({
    selector: z.literal("latest").optional(),
    commit: refSchema.optional(),
  })
  .strict()
  .refine(
    (query) => (query.selector === "latest") !== (query.commit !== undefined),
  );
export const historyQuerySchema = z
  .object({
    ...paginationSchema,
    includeFiltered: booleanQuerySchema.default(false),
  })
  .strict();
export const observationsQuerySchema = z.object(paginationSchema).strict();
export const diffQuerySchema = z
  .object({
    from: refSchema,
    to: refSchema,
    includeFiltered: booleanQuerySchema.default(false),
  })
  .strict();
export const searchQuerySchema = z
  .object({
    ...paginationSchema,
    includeFiltered: booleanQuerySchema.default(false),
    itemId: textSchema.optional(),
    label: textSchema.optional(),
    type: textSchema.optional(),
    statusTo: z.enum(["accepted", "done", "missing", "unknown"]).optional(),
    eventType: textSchema.optional(),
    direction: z.enum(["neutral", "progression", "regression"]).optional(),
    text: textSchema.optional(),
  })
  .strict()
  .refine((query) =>
    [
      query.itemId,
      query.label,
      query.type,
      query.statusTo,
      query.eventType,
      query.direction,
      query.text,
    ].some((value) => value !== undefined),
  );
export const checkpointBodySchema = z
  .object({
    message: textSchema.optional(),
    allowUnchanged: z.boolean().optional(),
  })
  .strict();
export const exportQuerySchema = z.object({ commit: refSchema }).strict();
export const expectedCurrentSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("present"),
      encodedSha256: z.string().regex(/^[0-9a-f]{64}$/v),
    })
    .strict(),
  z.object({ status: z.literal("missing") }).strict(),
]);
export const restoreBodySchema = z
  .object({
    commitRef: refSchema,
    confirmation: z.literal("restore-watched-save"),
    expectedCurrent: expectedCurrentSchema,
  })
  .strict();

const historyCommitSchema: z.ZodType<HistoryCommit> = z
  .object({
    ref: z.string(),
    shortRef: z.string(),
    committedAt: z.string(),
  })
  .openapi("HistoryCommit");
const decodedSaveVersionSchema = z.object({
  saveSchemaVersion: z.string(),
  gameVersion: z.string().optional(),
  platform: z.string().optional(),
  platformBuildId: z.string().optional(),
});
const recognizedSchemaStatus = z.literal("recognized");
const unrecognizedSchemaStatus = z.literal("unrecognized");
const recognizedObservationSchema = decodedSaveVersionSchema.extend({
  status: recognizedSchemaStatus,
});
const unrecognizedObservationSchema = z.object({
  status: unrecognizedSchemaStatus,
  reason: z.string(),
});
const observationSchema = z.union([
  recognizedObservationSchema,
  unrecognizedObservationSchema,
]);
const rawSaveObservationSchema: z.ZodType<RawSaveObservation> = z
  .object({
    commit: historyCommitSchema,
    observedAt: z.string(),
    trigger: z.enum(["watcher", "manualCheckpoint"]),
    message: z.string().optional(),
    sourcePath: z.string(),
    encodedSha256: z.string(),
    previousCommit: z.string().optional(),
    decodedSha256: z.string(),
    decoderVersion: z.string(),
    schema: observationSchema,
  })
  .openapi("RawSaveObservation");
const snapshotVersionSchema = z.object({
  saveSchemaVersion: z.string(),
  gameVersion: z.string().optional(),
  platform: z.string().optional(),
  platformBuildId: z.string().optional(),
  mappingDataVersion: z.string().optional(),
  semanticCoreVersion: z.string(),
  configHash: z.string().optional(),
});
const sceneFlagSourceSchema = z.object({
  kind: z.literal("sceneFlag"),
  scene: z.string(),
  flag: z.string(),
});
const playerDataSourceSchema = z.object({
  kind: z.literal("playerData"),
  field: z.string(),
});
const savedDataSourceSchema = z.object({
  kind: z.literal("savedData"),
  field: z.string(),
  name: z.string(),
});
const sourceReferenceSchema = z.discriminatedUnion("kind", [
  sceneFlagSourceSchema,
  playerDataSourceSchema,
  savedDataSourceSchema,
]);
const snapshotStatusSchema = z.enum(["accepted", "done", "missing", "unknown"]);
const sourceReferencesSchema = z.array(sourceReferenceSchema).readonly();
const semanticSnapshotItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  sectionId: z.string(),
  categoryId: z.string(),
  type: z.string(),
  status: snapshotStatusSchema,
  value: z.unknown(),
  sourceReferences: sourceReferencesSchema,
});
const semanticSnapshotItemsSchema = z
  .array(semanticSnapshotItemSchema)
  .readonly();
const saveSummarySchema = z.object({
  completionPercentage: z.number().optional(),
  playTime: z.number().optional(),
  rosaries: z.number().optional(),
  shellShards: z.number().optional(),
  permadeathMode: z.unknown().optional(),
});
const semanticSnapshotSchema: z.ZodType<SemanticSnapshot> = z
  .object({
    items: semanticSnapshotItemsSchema,
    summary: saveSummarySchema,
    version: snapshotVersionSchema,
  })
  .openapi("SemanticSnapshot");
const semanticEventVersionSchema = z.object({
  before: snapshotVersionSchema,
  after: snapshotVersionSchema,
});
const semanticEventDirectionSchema = z.enum([
  "neutral",
  "progression",
  "regression",
]);
const semanticEventItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  sectionId: z.string(),
  categoryId: z.string(),
  type: z.string(),
});
const semanticEventStateSchema = z.object({
  status: snapshotStatusSchema,
  value: z.unknown(),
});
const itemEventSchema = z.object({
  kind: z.literal("item"),
  eventType: z.enum(["itemStatusChanged", "itemValueChanged"]),
  item: semanticEventItemSchema,
  before: semanticEventStateSchema,
  after: semanticEventStateSchema,
  direction: semanticEventDirectionSchema,
  isRegression: z.boolean(),
  sourceReferences: sourceReferencesSchema,
  version: semanticEventVersionSchema,
});
const summaryMetricNameSchema = z.enum([
  "completionPercentage",
  "playTime",
  "rosaries",
  "shellShards",
  "permadeathMode",
]);
const summaryMetricEventSchema = z.object({
  kind: z.literal("summaryMetric"),
  eventType: z.literal("summaryMetricChanged"),
  metric: summaryMetricNameSchema,
  beforeValue: z.unknown(),
  afterValue: z.unknown(),
  direction: semanticEventDirectionSchema,
  isRegression: z.boolean(),
  sourceReferences: sourceReferencesSchema,
  version: semanticEventVersionSchema,
});
const semanticEventSchema: z.ZodType<SemanticEvent> = z.discriminatedUnion(
  "kind",
  [itemEventSchema, summaryMetricEventSchema],
);
const filterReasonsSchema = z.array(z.string()).readonly();
const eventVisibilitySchema = z.object({
  defaultVisible: z.boolean(),
  filterReasons: filterReasonsSchema,
});
const historicalSemanticEventSchema: z.ZodType<HistoricalSemanticEvent> = z
  .object({
    id: z.string(),
    commit: historyCommitSchema,
    previousCommit: historyCommitSchema.optional(),
    observation: rawSaveObservationSchema,
    event: semanticEventSchema,
    visibility: eventVisibilitySchema,
  })
  .openapi("HistoricalSemanticEvent");
const historyResultSchema: z.ZodType<HistoryResult> = z
  .object({
    events: z.array(historicalSemanticEventSchema).readonly(),
    nextCursor: z.string().optional(),
  })
  .openapi("HistoryResult");
const rawObservationHistoryResultSchema: z.ZodType<RawObservationHistoryResult> =
  z
    .object({
      observations: z.array(rawSaveObservationSchema).readonly(),
      nextCursor: z.string().optional(),
    })
    .openapi("RawObservationHistoryResult");
const saveStateResultSchema: z.ZodType<GetSaveStateResult> = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("available"),
      observation: rawSaveObservationSchema,
      decodedSave: z.unknown(),
      semanticSnapshot: semanticSnapshotSchema.nullable(),
    }),
    z.object({ status: z.literal("empty") }),
  ])
  .openapi("GetSaveStateResult");
const diffCommitsResultSchema: z.ZodType<DiffCommitsResult> = z
  .object({
    from: historyCommitSchema,
    to: historyCommitSchema,
    before: semanticSnapshotSchema,
    after: semanticSnapshotSchema,
    events: z.array(historicalSemanticEventSchema).readonly(),
  })
  .openapi("DiffCommitsResult");
const searchResultSchema: z.ZodType<SearchSemanticEventsResult> = z
  .object({
    events: z.array(historicalSemanticEventSchema).readonly(),
    nextCursor: z.string().optional(),
  })
  .openapi("SearchSemanticEventsResult");
const watcherErrorSchema = z.object({
  message: z.string(),
  reason: z.enum(["decodeFailure", "readFailure", "stabilityTimeout"]),
});
const observationCauseSchema = z.enum(["startup", "change", "deferred"]);
const committedObservationSummarySchema = z.object({
  cause: observationCauseSchema,
  completedAt: z.string(),
  status: z.literal("committed"),
  commit: historyCommitSchema,
  eventCount: z.number().int(),
  semanticStatus: z.enum(["updated", "notAvailable"]),
});
const skippedObservationSummarySchema = z.object({
  cause: observationCauseSchema,
  completedAt: z.string(),
  status: z.literal("skipped"),
  reason: z.enum(["unchanged", "minimumCommitInterval"]),
  nextAllowedAt: z.string().optional(),
});
const watcherErrorObservationSummarySchema = z.object({
  cause: observationCauseSchema,
  completedAt: z.string(),
  status: z.literal("watcherError"),
  error: watcherErrorSchema,
});
const observationSummarySchema = z.discriminatedUnion("status", [
  committedObservationSummarySchema,
  skippedObservationSummarySchema,
  watcherErrorObservationSummarySchema,
]);
const capturePolicySchema = z.object({
  debounceWriteMs: z.number(),
  minCommitIntervalMs: z.number(),
});
const watcherStatusSchema: z.ZodType<LocalHistoryWatcherStatus> = z
  .object({
    status: z.literal("running"),
    activity: z.enum(["idle", "pending", "observing"]),
    observationRevision: z.number().int(),
    startedAt: z.string(),
    repoPath: z.string(),
    watchedSavePath: z.string(),
    capturePolicy: capturePolicySchema,
    lastObservation: observationSummarySchema.optional(),
  })
  .openapi("LocalHistoryWatcherStatus");
const semanticUpdateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("updated"),
    snapshotId: z.string(),
    eventCount: z.number().int(),
    events: z.array(historicalSemanticEventSchema).readonly(),
  }),
  z.object({
    status: z.literal("notAvailable"),
    reason: z.enum(["unrecognizedSchema", "readModelUnavailable"]),
  }),
]);
const committedSaveResultSchema = z.object({
  status: z.literal("committed"),
  observation: rawSaveObservationSchema,
  semanticUpdate: semanticUpdateSchema,
});
const unchangedSaveResultSchema = z.object({
  status: z.literal("skipped"),
  reason: z.literal("unchanged"),
  encodedSha256: z.string(),
});
const deferredSaveResultSchema = z.object({
  status: z.literal("skipped"),
  reason: z.literal("minimumCommitInterval"),
  encodedSha256: z.string(),
  nextAllowedAt: z.string(),
});
const watcherErrorSaveResultSchema = z.object({
  status: z.literal("watcherError"),
  error: watcherErrorSchema,
});
const observeSaveResultSchema: z.ZodType<ObserveSaveResult> = z
  .discriminatedUnion("status", [
    committedSaveResultSchema,
    unchangedSaveResultSchema,
    deferredSaveResultSchema,
    watcherErrorSaveResultSchema,
  ])
  .openapi("ObserveSaveResult");
const restoreResultSchema: z.ZodType<RestoreEncodedSaveResult> = z
  .object({
    commit: historyCommitSchema,
    targetPath: z.string(),
    writtenSha256: z.string(),
    backupPath: z.string().optional(),
  })
  .openapi("RestoreEncodedSaveResult");
const apiVersionSchema = z.object({ major: z.literal(1), minor: z.literal(0) });
const apiIdentitySchema = z.object({
  name: z.literal("silksong-git-local-history"),
  version: apiVersionSchema,
});
const capabilitySchema = z.enum(localHttpCapabilities);
const capabilitiesSchema = z.array(capabilitySchema).readonly();
const metaSchema: z.ZodType<LocalHttpMeta> = z
  .object({
    api: apiIdentitySchema,
    repoPath: z.string(),
    watchedSavePath: z.string(),
    capabilities: capabilitiesSchema,
  })
  .openapi("LocalHttpMeta");
const errorSchema = z
  .object({
    error: z.object({
      code: z.enum(localHttpErrorCodes),
      message: z.string(),
    }),
  })
  .openapi("LocalHttpError");
function jsonSuccess(schema: z.ZodType) {
  return {
    description: "Successful response.",
    content: { "application/json": { schema } },
  } as const;
}
const invalidRequest = {
  description: "The request is invalid.",
  content: { "application/json": { schema: errorSchema } },
} as const;
const unauthorized = {
  description: "Bearer authentication failed.",
  content: { "application/json": { schema: errorSchema } },
} as const;
const internalError = {
  description: "The request failed without exposing internal details.",
  content: { "application/json": { schema: errorSchema } },
} as const;

const baseResponses = {
  400: invalidRequest,
  401: unauthorized,
  408: internalError,
  500: internalError,
} as const;

export const localHttpRoutes = {
  meta: createRoute({
    method: "get",
    path: "/api/v1/meta",
    summary: "Get Local History API compatibility metadata",
    responses: {
      200: jsonSuccess(metaSchema),
      401: unauthorized,
      500: internalError,
    },
  }),
  watcher: createRoute({
    method: "get",
    path: "/api/v1/watcher",
    summary: "Get the current watcher status",
    responses: {
      200: jsonSuccess(watcherStatusSchema),
      401: unauthorized,
      500: internalError,
    },
  }),
  save: createRoute({
    method: "get",
    path: "/api/v1/save",
    summary: "Get the latest or commit-selected Save State",
    request: { query: saveQuerySchema },
    responses: {
      200: jsonSuccess(saveStateResultSchema),
      404: internalError,
      ...baseResponses,
    },
  }),
  history: createRoute({
    method: "get",
    path: "/api/v1/history",
    summary: "Query Semantic Event history",
    request: { query: historyQuerySchema },
    responses: {
      200: jsonSuccess(historyResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  observations: createRoute({
    method: "get",
    path: "/api/v1/observations",
    summary: "Query Raw Save Observations",
    request: { query: observationsQuerySchema },
    responses: {
      200: jsonSuccess(rawObservationHistoryResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  diff: createRoute({
    method: "get",
    path: "/api/v1/diff",
    summary: "Diff two observation commits",
    request: { query: diffQuerySchema },
    responses: {
      200: jsonSuccess(diffCommitsResultSchema),
      404: internalError,
      503: internalError,
      ...baseResponses,
    },
  }),
  search: createRoute({
    method: "get",
    path: "/api/v1/search",
    summary: "Search Semantic Events",
    request: { query: searchQuerySchema },
    responses: {
      200: jsonSuccess(searchResultSchema),
      503: internalError,
      ...baseResponses,
    },
  }),
  checkpoints: createRoute({
    method: "post",
    path: "/api/v1/checkpoints",
    summary: "Create a manual checkpoint",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: checkpointBodySchema } },
      },
    },
    responses: {
      200: jsonSuccess(observeSaveResultSchema),
      409: internalError,
      413: invalidRequest,
      415: invalidRequest,
      422: invalidRequest,
      503: internalError,
      ...baseResponses,
    },
  }),
  export: createRoute({
    method: "get",
    path: "/api/v1/export",
    summary: "Export an exact committed Encoded Save",
    request: { query: exportQuerySchema },
    responses: {
      200: {
        description: "Exact committed Encoded Save bytes.",
        headers: {
          "Content-Disposition": { schema: { type: "string" } },
          ETag: { schema: { type: "string" } },
        },
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      404: internalError,
      ...baseResponses,
    },
  }),
  restoreInPlace: createRoute({
    method: "post",
    path: "/api/v1/restores/in-place",
    summary: "Restore a commit to the Watched Save",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: restoreBodySchema } },
      },
    },
    responses: {
      200: jsonSuccess(restoreResultSchema),
      404: internalError,
      409: internalError,
      413: invalidRequest,
      415: invalidRequest,
      ...baseResponses,
    },
  }),
} as const;

export type LocalHttpOpenApiDocument = ReturnType<
  OpenAPIHono<Record<string, never>>["getOpenAPI31Document"]
>;

export function createLocalHttpOpenApiDocument(): LocalHttpOpenApiDocument {
  const app = new OpenAPIHono<Record<string, never>>();
  const documentConfig = {
    info: {
      title: "Silksong Git Local History API",
      version: "1.0.0",
    },
    openapi: "3.1.0" as const,
    security: [{ bearerAuth: [] }],
  };

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });

  for (const route of Object.values(localHttpRoutes)) {
    app.openAPIRegistry.registerPath(route);
  }

  return app.getOpenAPI31Document(documentConfig, {
    unionPreferredType: "oneOf",
  });
}
