import { z } from "zod";

export const desktopSidecarProtocolVersion = 6 as const;

export const desktopSidecarErrorCodes = [
  "invalid_message",
  "unsupported_protocol_version",
  "unknown_command",
  "invalid_command",
  "invalid_repo_path",
  "repository_inspect_failed",
  "repository_initialize_failed",
  "repository_watched_save_compare_failed",
  "repository_migrate_failed",
  "repository_migration_not_prepared",
  "repository_rebuild_failed",
  "session_already_open",
  "session_not_open",
  "session_open_failed",
  "watcher_start_failed",
  "watcher_stop_failed",
  "shutdown_failed",
] as const;

const requestIdSchema = z.string().min(1).max(128);
const protocolVersionSchema = z.literal(desktopSidecarProtocolVersion);

export const incomingCommandEnvelopeSchema = z
  .object({
    protocolVersion: z.number().int(),
    kind: z.literal("command"),
    requestId: requestIdSchema,
    command: z
      .object({
        type: z.string().min(1).max(128),
      })
      .loose(),
  })
  .strict();

export const sessionOpenCommandSchema = z
  .object({
    type: z.literal("session.open"),
    repoPath: z.string().min(1).max(4096),
    // Placement is classified by Desktop. History deliberately has no archive placement concept, so
    // this is session policy rather than repository data.
    access: z.enum(["readWrite", "readOnly"]).default("readWrite"),
  })
  .strict();

export const repositoryInspectCommandSchema = z
  .object({
    type: z.literal("repository.inspect"),
    repoPath: z.string().min(1).max(4096),
    gitIntegrityPolicy: z.enum(["strict", "advisory"]).default("strict"),
  })
  .strict();

export const repositoryInitializeCommandSchema = z
  .object({
    type: z.literal("repository.initialize"),
    repoPath: z.string().min(1).max(4096),
    watchedSavePath: z.string().min(1).max(4096),
  })
  .strict();

export const repositoryCompareWatchedSaveCommandSchema = z
  .object({
    type: z.literal("repository.compareWatchedSave"),
    repoPath: z.string().min(1).max(4096),
    savePath: z.string().min(1).max(4096),
  })
  .strict();

export const repositoryMigrateCommandSchema = z
  .object({
    type: z.literal("repository.migrate"),
    repoPath: z.string().min(1).max(4096),
    inspectionId: z.string().min(1).max(128),
    confirmation: z.literal("migrate-save-history-repository"),
  })
  .strict();

export const repositoryMigrationPrepareCommandSchema = z
  .object({
    type: z.literal("repository.migration.prepare"),
    repoPath: z.string().min(1).max(4096),
    inspectionId: z.string().min(1).max(128),
    confirmation: z.literal("migrate-save-history-repository"),
    snapshotPath: z.string().min(1).max(4096),
  })
  .strict();

export const repositoryMigrationCommitCommandSchema = z
  .object({
    type: z.literal("repository.migration.commit"),
  })
  .strict();

export const repositoryRebuildCommandSchema = z
  .object({
    type: z.literal("repository.rebuild"),
    repoPath: z.string().min(1).max(4096),
  })
  .strict();

export const saveInspectCommandSchema = z
  .object({
    type: z.literal("save.inspect"),
    savePath: z.string().min(1).max(4096),
  })
  .strict();

export const watcherStartCommandSchema = z
  .object({
    type: z.literal("watcher.start"),
  })
  .strict();

export const watcherStopCommandSchema = z
  .object({
    type: z.literal("watcher.stop"),
  })
  .strict();

export const processShutdownCommandSchema = z
  .object({
    type: z.literal("process.shutdown"),
  })
  .strict();

const connectionSchema = z
  .object({
    endpoint: z.url(),
    bearerToken: z.string().regex(/^[\w\-]+$/v),
  })
  .strict();

const repositoryCapabilitySchema = z.enum([
  "read",
  "observe",
  "restore",
  "rebuildReadModel",
  "watch",
]);

const repositoryStatusSchema = z
  .object({
    status: z.enum([
      "ready",
      "rebuildRequired",
      "legacyConfig",
      "migrationRequired",
      "newerIncompatible",
      "invalid",
    ]),
    requiredAction: z.enum([
      "open",
      "rebuildReadModel",
      "confirmMigration",
      "useNewerApp",
      "chooseAnotherDirectory",
    ]),
    capabilities: z.array(repositoryCapabilitySchema),
  })
  .strict();

const repositoryInspectionSchema = repositoryStatusSchema
  .extend({
    inspectionId: z.string().min(1).max(128),
  })
  .strict();

const repositoryInitializationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("initialized") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      phase: z.enum(["repository", "baseline"]),
      reason: z.enum(["historyFailed", "observationFailed"]),
    })
    .strict(),
]);

const repositoryWatchedSaveComparisonSchema = z
  .object({ same: z.boolean() })
  .strict();

const migrationSourceStateSchema = z.enum(["unchanged", "migrated", "unknown"]);
const migrationCleanupFailureSchema = z.literal("leaseReleaseFailed");
const migrationSnapshotStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("notCreated") }).strict(),
  z
    .object({
      status: z.literal("retained"),
      repoPath: z.string().min(1).max(4096),
    })
    .strict(),
]);

const rebuildSemanticReadModelResultSchema = z
  .object({
    observationCount: z.number().int().nonnegative(),
    recognizedObservationCount: z.number().int().nonnegative(),
    unrecognizedObservationCount: z.number().int().nonnegative(),
    snapshotCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
  })
  .strict();

const repositoryMigrationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("migrated"),
      inspection: repositoryInspectionSchema,
      backupCreated: z.literal(true),
      sourceState: z.literal("migrated"),
      snapshotState: migrationSnapshotStateSchema,
      cleanupFailure: migrationCleanupFailureSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "confirmationRequired",
        "staleInspection",
        "migrationNotRequired",
      ]),
      sourceState: z.literal("unchanged"),
      snapshotState: migrationSnapshotStateSchema,
      cleanupFailure: migrationCleanupFailureSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum(["backupFailed", "repositoryBusy", "migrationFailed"]),
      sourceState: migrationSourceStateSchema,
      snapshotState: migrationSnapshotStateSchema,
      cleanupFailure: migrationCleanupFailureSchema.optional(),
    })
    .strict(),
]);

const archiveSnapshotSchema = z
  .object({
    repoPath: z.string().min(1).max(4096),
    directoryDigest: z.string().regex(/^[0-9a-f]{64}$/v),
    gitIntegrityWarning: z.string().optional(),
  })
  .strict();

const repositoryMigrationPreparationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("prepared"),
      snapshot: archiveSnapshotSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.enum([
        "confirmationRequired",
        "staleInspection",
        "migrationNotRequired",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      reason: z.enum([
        "snapshotFailed",
        "directoryDigestMismatch",
        "repositoryBusy",
        "watcherAlreadyAcquired",
      ]),
      message: z.string().optional(),
    })
    .strict(),
]);

const successResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("save.inspected"),
      decodedSave: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal("save.invalidFile") }).strict(),
  z.object({ type: z.literal("save.decodeFailed") }).strict(),
  z
    .object({
      type: z.literal("session.opened"),
      connection: connectionSchema,
      access: z.enum(["readWrite", "readOnly"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.inspected"),
      inspection: repositoryInspectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.initializationResult"),
      initialization: repositoryInitializationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.watchedSaveCompared"),
      same: repositoryWatchedSaveComparisonSchema.shape.same,
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.migrationPrepared"),
      preparation: repositoryMigrationPreparationSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.migrationResult"),
      migration: repositoryMigrationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("repository.rebuilt"),
      rebuild: rebuildSemanticReadModelResultSchema,
      repository: repositoryStatusSchema,
    })
    .strict(),
  z.object({ type: z.literal("watcher.started") }).strict(),
  z.object({ type: z.literal("watcher.stopped") }).strict(),
  z.object({ type: z.literal("process.shutdownComplete") }).strict(),
]);

const successResponseEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    kind: z.literal("response"),
    requestId: requestIdSchema,
    ok: z.literal(true),
    result: successResultSchema,
  })
  .strict();

const failureResponseEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    kind: z.literal("response"),
    requestId: requestIdSchema.nullable(),
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(desktopSidecarErrorCodes),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

const observationCauseSchema = z.enum(["startup", "change", "deferred"]);
const watcherObservationEventSchema = z.discriminatedUnion("status", [
  z
    .object({
      type: z.literal("watcher.observation"),
      cause: observationCauseSchema,
      status: z.literal("committed"),
      eventCount: z.number().int().nonnegative(),
      semanticStatus: z.enum(["updated", "notAvailable"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("watcher.observation"),
      cause: observationCauseSchema,
      status: z.literal("skipped"),
      reason: z.enum(["unchanged", "minimumCommitInterval"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("watcher.observation"),
      cause: observationCauseSchema,
      status: z.literal("watcherError"),
      reason: z.enum(["decodeFailure", "readFailure", "stabilityTimeout"]),
    })
    .strict(),
]);

const producedEventSchema = z.union([
  z.object({ type: z.literal("process.ready") }).strict(),
  watcherObservationEventSchema,
  z
    .object({
      type: z.literal("watcher.failed"),
      reason: z.literal("watchBackendFailure"),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.failed"),
      reason: z.literal("httpServerFailure"),
    })
    .strict(),
  z
    .object({
      type: z.literal("mutation.activity"),
      mutation: z.enum([
        "manualCheckpoint",
        "inPlaceRestore",
        "repositoryMigration",
        "managedInitialization",
      ]),
      status: z.enum(["started", "finished"]),
    })
    .strict(),
]);

const producedEventEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    kind: z.literal("event"),
    event: producedEventSchema,
  })
  .strict();
const currentEventTypes: ReadonlySet<string> = new Set([
  "mutation.activity",
  "process.ready",
  "session.failed",
  "watcher.failed",
  "watcher.observation",
]);

// The producer schema prevents accidental additions to current messages. The consumer schema
// deliberately keeps event payloads open so clients can ignore compatible future event types.
export const desktopSidecarProducedMessageSchema = z.union([
  successResponseEnvelopeSchema,
  failureResponseEnvelopeSchema,
  producedEventEnvelopeSchema,
]);

export const desktopSidecarOutputEnvelopeSchema = z.union([
  successResponseEnvelopeSchema,
  failureResponseEnvelopeSchema,
  createCompatibleEventEnvelopeSchema(),
]);

function createCompatibleEventSchema() {
  const eventTypeSchema = z.string().min(1);
  return z.object({ type: eventTypeSchema }).loose();
}

function createCompatibleEventEnvelopeSchema() {
  return z
    .object({
      protocolVersion: protocolVersionSchema,
      kind: z.literal("event"),
      event: createCompatibleEventSchema(),
    })
    .strict()
    .superRefine(requireValidCurrentEvent);
}

function requireValidCurrentEvent(
  envelope: {
    readonly protocolVersion: 6;
    readonly kind: "event";
    readonly event: { readonly type: string };
  },
  context: z.RefinementCtx,
) {
  if (
    currentEventTypes.has(envelope.event.type)
    && !producedEventEnvelopeSchema.safeParse(envelope).success
  ) {
    context.addIssue({
      code: "custom",
      message: "A known Desktop sidecar event has an invalid payload.",
    });
  }
}

export type DesktopSidecarProducedMessage = z.infer<
  typeof desktopSidecarProducedMessageSchema
>;
export type DesktopSidecarResponse =
  | z.infer<typeof successResponseEnvelopeSchema>
  | z.infer<typeof failureResponseEnvelopeSchema>;
export type DesktopSidecarEvent = z.infer<typeof producedEventSchema>;

export function createSuccessResponse(
  requestId: string,
  result: z.infer<typeof successResultSchema>,
): DesktopSidecarResponse {
  return {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId,
    ok: true,
    result,
  };
}

export function createFailureResponse(
  requestId: string | null,
  code: (typeof desktopSidecarErrorCodes)[number],
  message: string,
): DesktopSidecarResponse {
  return {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "response",
    requestId,
    ok: false,
    error: { code, message },
  };
}

export function createEventEnvelope(
  event: DesktopSidecarEvent,
): DesktopSidecarProducedMessage {
  return {
    protocolVersion: desktopSidecarProtocolVersion,
    kind: "event",
    event,
  };
}
