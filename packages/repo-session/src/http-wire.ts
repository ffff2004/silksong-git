import { z } from "zod";

import type { SemanticEvent, SemanticSnapshot } from "@silksong-git/core";
import type {
  DiffCommitsResult,
  GetSaveStateResult,
  HistoricalSemanticEvent,
  HistoryCommit,
  HistoryResult,
  InPlaceRestorePreflightResult,
  ObserveSaveResult,
  RawObservationHistoryEntry,
  RawObservationHistoryResult,
  RawSaveObservation,
  RestoreEncodedSaveResult,
  SearchSemanticEventsResult,
} from "@silksong-git/history";
import type { RepoSessionWatcherStatus } from "./types.ts";

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
  "repository_incompatible",
  "session_stopping",
  "read_only_session",
] as const;

export type LocalHttpErrorCode = (typeof localHttpErrorCodes)[number];

type ZodNamespace = typeof z;

export type LocalHttpSchemaDecorator = <T extends z.ZodType>(
  schema: T,
  refId: string,
) => T;

/* eslint-disable unicorn/max-nested-calls -- nested Zod calls mirror the wire DTO shape. */
// The return shape is intentionally inferred so plain and OpenAPI-decorated schemas share one
// builder.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createLocalHttpWireSchemas(
  zod: ZodNamespace,
  decorate: LocalHttpSchemaDecorator = (schema) => schema,
) {
  const repositoryCompatibilitySchema = zod
    .object({
      status: zod.enum([
        "rebuildRequired",
        "legacyConfig",
        "migrationRequired",
        "newerIncompatible",
        "invalid",
      ]),
      requiredAction: zod.enum([
        "rebuildReadModel",
        "confirmMigration",
        "useNewerApp",
        "chooseAnotherDirectory",
      ]),
      capabilities: zod.array(
        zod.enum(["read", "observe", "restore", "rebuildReadModel", "watch"]),
      ),
    })
    .strict();
  const localHttpErrorSchema = decorate(
    zod
      .object({
        error: zod
          .object({
            code: zod.enum(localHttpErrorCodes),
            message: zod.string(),
            repository: repositoryCompatibilitySchema.optional(),
          })
          .strict()
          .refine(
            (error) =>
              (error.code === "repository_incompatible")
              === (error.repository !== undefined),
            "Repository compatibility details must accompany repository_incompatible errors only.",
          ),
      })
      .strict(),
    "LocalHttpError",
  );

  const refSchema = zod.string().min(1).max(1024);
  const cursorSchema = zod.string().min(1).max(4096);
  const textSchema = zod.string().min(1).max(1000);
  const booleanQuerySchema = zod
    .enum(["true", "false"])
    .transform((value) => value === "true");
  const paginationSchema = {
    limit: zod.coerce.number().int().min(1).max(1000).default(100),
    cursor: cursorSchema.optional(),
    order: zod.enum(["asc", "desc"]).default("desc"),
  } as const;
  const emptyQuerySchema = zod.object({}).strict();
  const saveQuerySchema = zod
    .object({
      selector: zod.literal("latest").optional(),
      commit: refSchema.optional(),
    })
    .strict()
    .refine(
      (query) => (query.selector === "latest") !== (query.commit !== undefined),
    );
  const historyQuerySchema = zod
    .object({
      ...paginationSchema,
      includeFiltered: booleanQuerySchema.default(false),
    })
    .strict();
  const observationsQuerySchema = zod.object(paginationSchema).strict();
  const diffQuerySchema = zod
    .object({
      from: refSchema,
      to: refSchema,
      includeFiltered: booleanQuerySchema.default(false),
    })
    .strict();
  const searchQuerySchema = zod
    .object({
      ...paginationSchema,
      includeFiltered: booleanQuerySchema.default(false),
      itemId: textSchema.optional(),
      label: textSchema.optional(),
      type: textSchema.optional(),
      statusTo: zod.enum(["accepted", "done", "missing", "unknown"]).optional(),
      eventType: textSchema.optional(),
      direction: zod.enum(["neutral", "progression", "regression"]).optional(),
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
  const checkpointBodySchema = zod
    .object({
      message: textSchema.optional(),
      allowUnchanged: zod.boolean().optional(),
    })
    .strict();
  const exportQuerySchema = zod.object({ commit: refSchema }).strict();
  const expectedCurrentSchema = zod.discriminatedUnion("status", [
    zod
      .object({
        status: zod.literal("present"),
        encodedSha256: zod.string().regex(/^[0-9a-f]{64}$/v),
      })
      .strict(),
    zod.object({ status: zod.literal("missing") }).strict(),
  ]);
  const restoreBodySchema = zod
    .object({
      commitRef: refSchema,
      confirmation: zod.literal("restore-watched-save"),
      expectedCurrent: expectedCurrentSchema,
    })
    .strict();
  const restorePreflightResultSchema: z.ZodType<InPlaceRestorePreflightResult> =
    decorate(
      zod.discriminatedUnion("status", [
        zod.object({ status: zod.literal("emptyHistory") }).strict(),
        zod
          .object({
            status: zod.literal("targetMissing"),
            expectedCurrent: zod
              .object({ status: zod.literal("missing") })
              .strict(),
          })
          .strict(),
        zod
          .object({
            status: zod.literal("targetPresent"),
            expectedCurrent: zod
              .object({
                status: zod.literal("present"),
                encodedSha256: zod.string().regex(/^[0-9a-f]{64}$/v),
              })
              .strict(),
          })
          .strict(),
      ]),
      "InPlaceRestorePreflightResult",
    );

  const historyCommitSchema: z.ZodType<HistoryCommit> = decorate(
    zod.object({
      ref: zod.string(),
      shortRef: zod.string(),
      committedAt: zod.string(),
    }),
    "HistoryCommit",
  );
  const decodedSaveVersionSchema = zod.object({
    saveSchemaVersion: zod.string(),
    gameVersion: zod.string().optional(),
    platform: zod.string().optional(),
    platformBuildId: zod.string().optional(),
  });
  const recognizedSchemaStatus = zod.literal("recognized");
  const unrecognizedSchemaStatus = zod.literal("unrecognized");
  const recognizedObservationSchema = decodedSaveVersionSchema.extend({
    status: recognizedSchemaStatus,
  });
  const unrecognizedObservationSchema = zod.object({
    status: unrecognizedSchemaStatus,
    reason: zod.string(),
  });
  const observationSchema = zod.union([
    recognizedObservationSchema,
    unrecognizedObservationSchema,
  ]);
  const rawSaveObservationSchema: z.ZodType<RawSaveObservation> = decorate(
    zod.object({
      commit: historyCommitSchema,
      observedAt: zod.string(),
      trigger: zod.enum(["watcher", "manualCheckpoint"]),
      message: zod.string().optional(),
      sourcePath: zod.string(),
      encodedSha256: zod.string(),
      previousCommit: zod.string().optional(),
      decodedSha256: zod.string(),
      decoderVersion: zod.string(),
      schema: observationSchema,
    }),
    "RawSaveObservation",
  );
  const snapshotVersionSchema = zod.object({
    saveSchemaVersion: zod.string(),
    gameVersion: zod.string().optional(),
    platform: zod.string().optional(),
    platformBuildId: zod.string().optional(),
    mappingDataVersion: zod.string().optional(),
    semanticCoreVersion: zod.string(),
    configHash: zod.string().optional(),
  });
  const sceneFlagSourceSchema = zod.object({
    kind: zod.literal("sceneFlag"),
    scene: zod.string(),
    flag: zod.string(),
  });
  const playerDataSourceSchema = zod.object({
    kind: zod.literal("playerData"),
    field: zod.string(),
  });
  const savedDataSourceSchema = zod.object({
    kind: zod.literal("savedData"),
    field: zod.string(),
    name: zod.string(),
  });
  const sourceReferenceSchema = zod.discriminatedUnion("kind", [
    sceneFlagSourceSchema,
    playerDataSourceSchema,
    savedDataSourceSchema,
  ]);
  const snapshotStatusSchema = zod.enum([
    "accepted",
    "done",
    "missing",
    "unknown",
  ]);
  const sourceReferencesSchema = zod.array(sourceReferenceSchema).readonly();
  const semanticSnapshotItemSchema = zod.object({
    id: zod.string(),
    label: zod.string(),
    sectionId: zod.string(),
    type: zod.string(),
    status: snapshotStatusSchema,
    value: zod.unknown(),
    sourceReferences: sourceReferencesSchema,
  });
  const semanticSnapshotItemsSchema = zod
    .array(semanticSnapshotItemSchema)
    .readonly();
  const saveSummarySchema = zod.object({
    completionPercentage: zod.number().optional(),
    playTime: zod.number().optional(),
    rosaries: zod.number().optional(),
    shellShards: zod.number().optional(),
    permadeathMode: zod.unknown().optional(),
  });
  const semanticSnapshotSchema: z.ZodType<SemanticSnapshot> = decorate(
    zod.object({
      items: semanticSnapshotItemsSchema,
      summary: saveSummarySchema,
      version: snapshotVersionSchema,
    }),
    "SemanticSnapshot",
  );
  const semanticEventVersionSchema = zod.object({
    before: snapshotVersionSchema,
    after: snapshotVersionSchema,
  });
  const semanticEventDirectionSchema = zod.enum([
    "neutral",
    "progression",
    "regression",
  ]);
  const semanticEventItemSchema = zod.object({
    id: zod.string(),
    label: zod.string(),
    sectionId: zod.string(),
    type: zod.string(),
  });
  const semanticEventStateSchema = zod.object({
    status: snapshotStatusSchema,
    value: zod.unknown(),
  });
  const itemEventSchema = zod.object({
    kind: zod.literal("item"),
    eventType: zod.enum(["itemStatusChanged", "itemValueChanged"]),
    item: semanticEventItemSchema,
    before: semanticEventStateSchema,
    after: semanticEventStateSchema,
    direction: semanticEventDirectionSchema,
    isRegression: zod.boolean(),
    sourceReferences: sourceReferencesSchema,
    version: semanticEventVersionSchema,
  });
  const summaryMetricNameSchema = zod.enum([
    "completionPercentage",
    "playTime",
    "rosaries",
    "shellShards",
    "permadeathMode",
  ]);
  const summaryMetricEventSchema = zod.object({
    kind: zod.literal("summaryMetric"),
    eventType: zod.literal("summaryMetricChanged"),
    metric: summaryMetricNameSchema,
    beforeValue: zod.unknown(),
    afterValue: zod.unknown(),
    direction: semanticEventDirectionSchema,
    isRegression: zod.boolean(),
    sourceReferences: sourceReferencesSchema,
    version: semanticEventVersionSchema,
  });
  const semanticEventSchema: z.ZodType<SemanticEvent> = zod.discriminatedUnion(
    "kind",
    [itemEventSchema, summaryMetricEventSchema],
  );
  const filterReasonsSchema = zod.array(zod.string()).readonly();
  const eventVisibilitySchema = zod.object({
    defaultVisible: zod.boolean(),
    filterReasons: filterReasonsSchema,
  });
  const historicalSemanticEventSchema: z.ZodType<HistoricalSemanticEvent> =
    decorate(
      zod.object({
        id: zod.string(),
        commit: historyCommitSchema,
        previousCommit: historyCommitSchema.optional(),
        observation: rawSaveObservationSchema,
        snapshotSummary: saveSummarySchema,
        event: semanticEventSchema,
        visibility: eventVisibilitySchema,
      }),
      "HistoricalSemanticEvent",
    );
  const historyResultSchema: z.ZodType<HistoryResult> = decorate(
    zod.object({
      events: zod.array(historicalSemanticEventSchema).readonly(),
      nextCursor: zod.string().optional(),
    }),
    "HistoryResult",
  );
  const rawObservationHistoryEntrySchema: z.ZodType<RawObservationHistoryEntry> =
    decorate(
      zod.object({
        observation: rawSaveObservationSchema,
        snapshotSummary: saveSummarySchema.nullable(),
      }),
      "RawObservationHistoryEntry",
    );
  const rawObservationHistoryResultSchema: z.ZodType<RawObservationHistoryResult> =
    decorate(
      zod.object({
        entries: zod.array(rawObservationHistoryEntrySchema).readonly(),
        nextCursor: zod.string().optional(),
      }),
      "RawObservationHistoryResult",
    );
  const saveStateResultSchema: z.ZodType<GetSaveStateResult> = decorate(
    zod.discriminatedUnion("status", [
      zod.object({
        status: zod.literal("available"),
        observation: rawSaveObservationSchema,
        decodedSave: zod.unknown(),
        semanticSnapshot: semanticSnapshotSchema.nullable(),
      }),
      zod.object({ status: zod.literal("empty") }),
    ]),
    "GetSaveStateResult",
  );
  const diffCommitsResultSchema: z.ZodType<DiffCommitsResult> = decorate(
    zod.object({
      from: historyCommitSchema,
      to: historyCommitSchema,
      before: semanticSnapshotSchema,
      after: semanticSnapshotSchema,
      events: zod.array(historicalSemanticEventSchema).readonly(),
    }),
    "DiffCommitsResult",
  );
  const searchResultSchema: z.ZodType<SearchSemanticEventsResult> = decorate(
    zod.object({
      events: zod.array(historicalSemanticEventSchema).readonly(),
      nextCursor: zod.string().optional(),
    }),
    "SearchSemanticEventsResult",
  );
  const watcherErrorSchema = zod.object({
    message: zod.string(),
    reason: zod.enum(["decodeFailure", "readFailure", "stabilityTimeout"]),
  });
  const observationCauseSchema = zod.enum(["startup", "change", "deferred"]);
  const committedObservationSummarySchema = zod.object({
    cause: observationCauseSchema,
    completedAt: zod.string(),
    status: zod.literal("committed"),
    commit: historyCommitSchema,
    eventCount: zod.number().int(),
    semanticStatus: zod.enum(["updated", "notAvailable"]),
  });
  const skippedObservationSummarySchema = zod.object({
    cause: observationCauseSchema,
    completedAt: zod.string(),
    status: zod.literal("skipped"),
    reason: zod.enum(["unchanged", "minimumCommitInterval"]),
    nextAllowedAt: zod.string().optional(),
  });
  const watcherErrorObservationSummarySchema = zod.object({
    cause: observationCauseSchema,
    completedAt: zod.string(),
    status: zod.literal("watcherError"),
    error: watcherErrorSchema,
  });
  const observationSummarySchema = zod.discriminatedUnion("status", [
    committedObservationSummarySchema,
    skippedObservationSummarySchema,
    watcherErrorObservationSummarySchema,
  ]);
  const capturePolicySchema = zod.object({
    debounceWriteMs: zod.number(),
    minCommitIntervalMs: zod.number(),
  });
  const watcherStatusCommon = {
    observationRevision: zod.number().int(),
    repoPath: zod.string(),
    lastObservation: observationSummarySchema.optional(),
  } as const;
  const watcherStatusSchema: z.ZodType<RepoSessionWatcherStatus> = decorate(
    zod.discriminatedUnion("status", [
      zod.object({ ...watcherStatusCommon, status: zod.literal("inactive") }),
      zod.object({ ...watcherStatusCommon, status: zod.literal("starting") }),
      zod.object({
        ...watcherStatusCommon,
        status: zod.literal("running"),
        activity: zod.enum(["idle", "pending", "observing"]),
        startedAt: zod.string(),
        watchedSavePath: zod.string(),
        capturePolicy: capturePolicySchema,
      }),
      zod.object({
        ...watcherStatusCommon,
        status: zod.literal("stopping"),
        activity: zod.enum(["idle", "pending", "observing"]),
        startedAt: zod.string(),
        watchedSavePath: zod.string(),
        capturePolicy: capturePolicySchema,
      }),
    ]),
    "RepoSessionWatcherStatus",
  );
  const semanticUpdateSchema = zod.discriminatedUnion("status", [
    zod.object({
      status: zod.literal("updated"),
      snapshotId: zod.string(),
      eventCount: zod.number().int(),
      events: zod.array(historicalSemanticEventSchema).readonly(),
    }),
    zod.object({
      status: zod.literal("notAvailable"),
      reason: zod.enum(["unrecognizedSchema", "readModelUnavailable"]),
    }),
  ]);
  const committedSaveResultSchema = zod.object({
    status: zod.literal("committed"),
    observation: rawSaveObservationSchema,
    semanticUpdate: semanticUpdateSchema,
  });
  const unchangedSaveResultSchema = zod.object({
    status: zod.literal("skipped"),
    reason: zod.literal("unchanged"),
    encodedSha256: zod.string(),
  });
  const deferredSaveResultSchema = zod.object({
    status: zod.literal("skipped"),
    reason: zod.literal("minimumCommitInterval"),
    encodedSha256: zod.string(),
    nextAllowedAt: zod.string(),
  });
  const watcherErrorSaveResultSchema = zod.object({
    status: zod.literal("watcherError"),
    error: watcherErrorSchema,
  });
  const observeSaveResultSchema: z.ZodType<ObserveSaveResult> = decorate(
    zod.union([
      committedSaveResultSchema,
      unchangedSaveResultSchema,
      deferredSaveResultSchema,
      watcherErrorSaveResultSchema,
    ]),
    "ObserveSaveResult",
  );
  const restoreResultSchema: z.ZodType<RestoreEncodedSaveResult> = decorate(
    zod.object({
      commit: historyCommitSchema,
      targetPath: zod.string(),
      writtenSha256: zod.string(),
      backupPath: zod.string().optional(),
    }),
    "RestoreEncodedSaveResult",
  );

  return {
    localHttpErrorSchema,
    refSchema,
    cursorSchema,
    textSchema,
    booleanQuerySchema,
    paginationSchema,
    emptyQuerySchema,
    saveQuerySchema,
    historyQuerySchema,
    observationsQuerySchema,
    diffQuerySchema,
    searchQuerySchema,
    checkpointBodySchema,
    exportQuerySchema,
    expectedCurrentSchema,
    restoreBodySchema,
    restorePreflightResultSchema,
    historyCommitSchema,
    decodedSaveVersionSchema,
    recognizedSchemaStatus,
    unrecognizedSchemaStatus,
    recognizedObservationSchema,
    unrecognizedObservationSchema,
    observationSchema,
    rawSaveObservationSchema,
    snapshotVersionSchema,
    sceneFlagSourceSchema,
    playerDataSourceSchema,
    savedDataSourceSchema,
    sourceReferenceSchema,
    snapshotStatusSchema,
    sourceReferencesSchema,
    semanticSnapshotItemSchema,
    semanticSnapshotItemsSchema,
    saveSummarySchema,
    semanticSnapshotSchema,
    semanticEventVersionSchema,
    semanticEventDirectionSchema,
    semanticEventItemSchema,
    semanticEventStateSchema,
    itemEventSchema,
    summaryMetricNameSchema,
    summaryMetricEventSchema,
    semanticEventSchema,
    filterReasonsSchema,
    eventVisibilitySchema,
    historicalSemanticEventSchema,
    historyResultSchema,
    rawObservationHistoryEntrySchema,
    rawObservationHistoryResultSchema,
    saveStateResultSchema,
    diffCommitsResultSchema,
    searchResultSchema,
    watcherErrorSchema,
    observationCauseSchema,
    committedObservationSummarySchema,
    skippedObservationSummarySchema,
    watcherErrorObservationSummarySchema,
    observationSummarySchema,
    capturePolicySchema,
    watcherStatusSchema,
    semanticUpdateSchema,
    committedSaveResultSchema,
    unchangedSaveResultSchema,
    deferredSaveResultSchema,
    watcherErrorSaveResultSchema,
    observeSaveResultSchema,
    restoreResultSchema,
  };
}
/* eslint-enable unicorn/max-nested-calls */

const wireSchemas = createLocalHttpWireSchemas(z);

export const {
  localHttpErrorSchema,
  refSchema,
  cursorSchema,
  textSchema,
  booleanQuerySchema,
  paginationSchema,
  emptyQuerySchema,
  saveQuerySchema,
  historyQuerySchema,
  observationsQuerySchema,
  diffQuerySchema,
  searchQuerySchema,
  checkpointBodySchema,
  exportQuerySchema,
  expectedCurrentSchema,
  restoreBodySchema,
  restorePreflightResultSchema,
  historyCommitSchema,
  decodedSaveVersionSchema,
  recognizedSchemaStatus,
  unrecognizedSchemaStatus,
  recognizedObservationSchema,
  unrecognizedObservationSchema,
  observationSchema,
  rawSaveObservationSchema,
  snapshotVersionSchema,
  sceneFlagSourceSchema,
  playerDataSourceSchema,
  savedDataSourceSchema,
  sourceReferenceSchema,
  snapshotStatusSchema,
  sourceReferencesSchema,
  semanticSnapshotItemSchema,
  semanticSnapshotItemsSchema,
  saveSummarySchema,
  semanticSnapshotSchema,
  semanticEventVersionSchema,
  semanticEventDirectionSchema,
  semanticEventItemSchema,
  semanticEventStateSchema,
  itemEventSchema,
  summaryMetricNameSchema,
  summaryMetricEventSchema,
  semanticEventSchema,
  filterReasonsSchema,
  eventVisibilitySchema,
  historicalSemanticEventSchema,
  historyResultSchema,
  rawObservationHistoryEntrySchema,
  rawObservationHistoryResultSchema,
  saveStateResultSchema,
  diffCommitsResultSchema,
  searchResultSchema,
  watcherErrorSchema,
  observationCauseSchema,
  committedObservationSummarySchema,
  skippedObservationSummarySchema,
  watcherErrorObservationSummarySchema,
  observationSummarySchema,
  capturePolicySchema,
  watcherStatusSchema,
  semanticUpdateSchema,
  committedSaveResultSchema,
  unchangedSaveResultSchema,
  deferredSaveResultSchema,
  watcherErrorSaveResultSchema,
  observeSaveResultSchema,
  restoreResultSchema,
} = wireSchemas;

export type LocalHttpError = z.infer<typeof localHttpErrorSchema>;
export type LocalHttpSaveState = z.infer<typeof saveStateResultSchema>;
export type LocalHttpHistoryResult = z.infer<typeof historyResultSchema>;
export type LocalHttpObservationHistoryResult = z.infer<
  typeof rawObservationHistoryResultSchema
>;
export type LocalHttpDiffResult = z.infer<typeof diffCommitsResultSchema>;
export type LocalHttpSearchResult = z.infer<typeof searchResultSchema>;
export type LocalHttpWatcherStatus = z.infer<typeof watcherStatusSchema>;
export type LocalHttpCheckpointResult = z.infer<typeof observeSaveResultSchema>;
export type LocalHttpRestoreResult = z.infer<typeof restoreResultSchema>;
export type LocalHttpRestorePreflightResult = z.infer<
  typeof restorePreflightResultSchema
>;
