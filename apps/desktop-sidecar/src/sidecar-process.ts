import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { decodeEncodedSave } from "@silksong-git/core";
import type {
  MigrateSaveHistoryRepositoryResult,
  PrepareSaveHistoryMigrationResult,
  PreparedSaveHistoryMigration,
  RebuildSemanticReadModelResult,
  RelocateRepositoryResult,
  RepositoryReplacementPreparationResult,
  RepositoryReplacementResolution,
  SaveHistoryRepositoryInspection,
} from "@silksong-git/history";
import {
  compareWatchedSave,
  initSaveHistory,
  inspectSaveHistoryRepository,
  migrateSaveHistoryRepository,
  observeSave,
  prepareRepositoryReplacement as prepareHistoryRepositoryReplacement,
  prepareSaveHistoryMigration,
  rebuildSemanticReadModel,
  relocateRepository,
} from "@silksong-git/history";
import type { RepoSession, RepoSessionEvent } from "@silksong-git/repo-session";
import { openRepoSession } from "@silksong-git/repo-session";

import type {
  DesktopSidecarEvent,
  DesktopSidecarProducedMessage,
  DesktopSidecarResponse,
} from "./protocol.ts";
import {
  createEventEnvelope,
  createFailureResponse,
  createSuccessResponse,
  desktopSidecarProducedMessageSchema,
  desktopSidecarProtocolVersion,
  incomingCommandEnvelopeSchema,
  processShutdownCommandSchema,
  repositoryArchiveCommandSchema,
  repositoryCompareWatchedSaveCommandSchema,
  repositoryInitializeCommandSchema,
  repositoryInspectCommandSchema,
  repositoryMigrateCommandSchema,
  repositoryMigrationCommitCommandSchema,
  repositoryMigrationPrepareCommandSchema,
  repositoryRebuildCommandSchema,
  repositoryReplacementPrepareCommandSchema,
  repositoryReplacementResolveCommandSchema,
  saveInspectCommandSchema,
  sessionOpenCommandSchema,
  watcherStartCommandSchema,
  watcherStopCommandSchema,
} from "./protocol.ts";

export interface DesktopSidecarProcessInput {
  readonly input: NodeJS.ReadableStream;
  readonly output: Writable;
  readonly diagnostics: Writable;
}

export async function runDesktopSidecarProcess(
  input: DesktopSidecarProcessInput,
): Promise<0 | 1> {
  const lines = createInterface({ input: input.input });
  let session: RepoSession | undefined;
  let preparedMigration: PreparedSaveHistoryMigration | undefined;
  let pendingReplacement:
    | {
        readonly operationId: string;
        readonly operation: Extract<
          RepositoryReplacementPreparationResult,
          { readonly status: "prepared" }
        >["operation"];
      }
    | undefined;
  let completedReplacement:
    | {
        readonly operationId: string;
        readonly resolution: RepositoryReplacementResolution;
      }
    | undefined;
  let commandEvents: DesktopSidecarEvent[] | undefined;
  const processState = {
    gracefulShutdown: false,
    unexpectedStop: false,
  };
  let outputTail = Promise.resolve();

  const requestUnexpectedStop = () => {
    processState.unexpectedStop = true;
    lines.close();
    input.input.pause();
  };
  const handleSigint = requestUnexpectedStop;
  const handleSigterm = requestUnexpectedStop;

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  input.output.on("error", requestUnexpectedStop);

  try {
    await processCommands();
  } catch {
    processState.unexpectedStop = true;
  } finally {
    await cleanUpProcess();
  }

  const exitCode =
    processState.gracefulShutdown && !processState.unexpectedStop ? 0 : 1;
  if (exitCode === 1) {
    writeDiagnostic("Desktop sidecar stopped without a graceful shutdown.");
  }

  return exitCode;

  async function processCommands() {
    await writeMessage(createEventEnvelope({ type: "process.ready" }));

    for await (const line of lines) {
      commandEvents = [];
      const { response, exitAfterResponse } = await handleLine(line);
      await writeMessage(response);
      await flushCommandEvents();

      if (exitAfterResponse) {
        processState.gracefulShutdown = response.ok;
        break;
      }
    }
  }

  async function cleanUpProcess() {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    input.output.off("error", requestUnexpectedStop);
    lines.close();
    input.input.pause();

    if (!processState.gracefulShutdown) {
      await releasePreparedReplacementAfterUnexpectedExit();
      await releasePreparedMigrationAfterUnexpectedExit();
      await stopSessionAfterUnexpectedExit();
    }

    try {
      await outputTail;
    } catch {
      processState.unexpectedStop = true;
    }
  }

  async function handleLine(line: string): Promise<{
    readonly response: DesktopSidecarResponse;
    readonly exitAfterResponse: boolean;
  }> {
    let decoded: unknown;

    try {
      decoded = JSON.parse(line);
    } catch {
      return {
        response: createFailureResponse(
          // The protocol uses null only when no request identity was accepted.
          // eslint-disable-next-line unicorn/no-null
          null,
          "invalid_message",
          "The input line is not valid JSON.",
        ),
        exitAfterResponse: false,
      };
    }

    const envelopeResult = incomingCommandEnvelopeSchema.safeParse(decoded);
    if (!envelopeResult.success) {
      return {
        response: createFailureResponse(
          // The protocol uses null only when no request identity was accepted.
          // eslint-disable-next-line unicorn/no-null
          null,
          "invalid_message",
          "The input line is not a valid command envelope.",
        ),
        exitAfterResponse: false,
      };
    }

    const envelope = envelopeResult.data;
    if (envelope.protocolVersion !== desktopSidecarProtocolVersion) {
      return {
        response: createFailureResponse(
          envelope.requestId,
          "unsupported_protocol_version",
          "The command uses an unsupported protocol version.",
        ),
        exitAfterResponse: false,
      };
    }

    switch (envelope.command.type) {
      case "repository.inspect": {
        return {
          response: await inspectRepository(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.initialize": {
        return {
          response: await initializeRepository(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.compareWatchedSave": {
        return {
          response: await compareRepositoryWatchedSave(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.archive": {
        return {
          response: await archiveRepository(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.migrate": {
        return {
          response: await migrateRepository(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.migration.prepare": {
        return {
          response: await prepareRepositoryMigration(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.migration.commit": {
        return {
          response: await commitRepositoryMigration(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.replacement.prepare": {
        return {
          response: await prepareRepositoryReplacement(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.replacement.resolve": {
        return {
          response: await resolveRepositoryReplacement(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "repository.rebuild": {
        return {
          response: await rebuildRepository(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "save.inspect": {
        return {
          response: await inspectEncodedSave(
            envelope.requestId,
            envelope.command,
          ),
          exitAfterResponse: false,
        };
      }

      case "session.open": {
        return {
          response: await openSession(envelope.requestId, envelope.command),
          exitAfterResponse: false,
        };
      }

      case "watcher.start": {
        return {
          response: await startWatcher(envelope.requestId, envelope.command),
          exitAfterResponse: false,
        };
      }

      case "watcher.stop": {
        return {
          response: await stopWatcher(envelope.requestId, envelope.command),
          exitAfterResponse: false,
        };
      }

      case "process.shutdown": {
        const response = await shutDown(envelope.requestId, envelope.command);
        return {
          response,
          exitAfterResponse:
            response.ok || response.error.code === "shutdown_failed",
        };
      }

      default: {
        return {
          response: createFailureResponse(
            envelope.requestId,
            "unknown_command",
            "The command type is not supported.",
          ),
          exitAfterResponse: false,
        };
      }
    }
  }

  async function openSession(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = sessionOpenCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The session.open command is invalid.",
      );
    }
    if (!path.isAbsolute(commandResult.data.repoPath)) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository path must be absolute.",
      );
    }
    if (session !== undefined) {
      return createFailureResponse(
        requestId,
        "session_already_open",
        "This process already owns a Repo Session.",
      );
    }
    try {
      session = await openRepoSession({
        repoPath: commandResult.data.repoPath,
        access: commandResult.data.access,
        onEvent: handleRepoSessionEvent,
      });

      return createSuccessResponse(requestId, {
        type: "session.opened",
        access: session.access,
        connection: {
          endpoint: session.http.endpoint,
          bearerToken: session.http.token,
        },
      });
    } catch {
      writeDiagnostic("Repo Session open failed.");
      return createFailureResponse(
        requestId,
        "session_open_failed",
        "The Repo Session could not be opened.",
      );
    }
  }

  async function inspectEncodedSave(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = saveInspectCommandSchema.safeParse(command);
    if (
      !commandResult.success
      || !path.isAbsolute(commandResult.data.savePath)
    ) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The save.inspect command is invalid.",
      );
    }

    const encodedSave = await readReadableRegularFile(
      commandResult.data.savePath,
    );
    if (encodedSave === undefined) {
      return createSuccessResponse(requestId, { type: "save.invalidFile" });
    }
    const decoded = decodeSave(encodedSave);
    return createSuccessResponse(
      requestId,
      decoded.ok
        ? { type: "save.inspected", decodedSave: decoded.decodedSave }
        : { type: "save.decodeFailed" },
    );
  }

  async function inspectRepository(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = repositoryInspectCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.inspect command is invalid.",
      );
    }
    if (!path.isAbsolute(commandResult.data.repoPath)) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository path must be absolute.",
      );
    }
    try {
      return createSuccessResponse(requestId, {
        type: "repository.inspected",
        inspection: toProtocolInspection(
          await inspectSaveHistoryRepository({
            repoPath: commandResult.data.repoPath,
            gitIntegrityPolicy: commandResult.data.gitIntegrityPolicy,
          }),
        ),
      });
    } catch {
      writeDiagnostic("Repository inspection failed.");
      return createFailureResponse(
        requestId,
        "repository_inspect_failed",
        "The Save History Repository could not be inspected.",
      );
    }
  }

  async function initializeRepository(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = repositoryInitializeCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.initialize command is invalid.",
      );
    }
    if (
      !path.isAbsolute(commandResult.data.repoPath)
      || !path.isAbsolute(commandResult.data.watchedSavePath)
    ) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The initialization paths must be absolute.",
      );
    }
    if (session !== undefined) {
      return createFailureResponse(
        requestId,
        "repository_initialize_failed",
        "The repository cannot initialize while a Repo Session is open.",
      );
    }
    if (preparedMigration !== undefined) {
      return createFailureResponse(
        requestId,
        "repository_initialize_failed",
        "The repository cannot initialize while a repository migration is in progress.",
      );
    }

    emitEvent({
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "started",
    });
    const initialized = await initSaveHistory({
      repoPath: commandResult.data.repoPath,
      watchedSavePath: commandResult.data.watchedSavePath,
    }).catch(() => undefined);
    let response: DesktopSidecarResponse;
    if (initialized === undefined) {
      response = createSuccessResponse(requestId, {
        type: "repository.initializationResult",
        initialization: {
          status: "failed",
          phase: "repository",
          reason: "historyFailed",
        },
      });
    } else {
      const baseline = await observeSave({
        repoPath: initialized.repoPath,
        trigger: "watcher",
      }).catch(() => undefined);
      response = createSuccessResponse(
        requestId,
        baseline?.status === "committed"
          ? {
              type: "repository.initializationResult",
              initialization: { status: "initialized" },
            }
          : {
              type: "repository.initializationResult",
              initialization: {
                status: "failed",
                phase: "baseline",
                reason: "observationFailed",
              },
            },
      );
    }
    emitEvent({
      type: "mutation.activity",
      mutation: "managedInitialization",
      status: "finished",
    });
    return response;
  }

  async function compareRepositoryWatchedSave(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult =
      repositoryCompareWatchedSaveCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.compareWatchedSave command is invalid.",
      );
    }
    if (
      !path.isAbsolute(commandResult.data.repoPath)
      || !path.isAbsolute(commandResult.data.savePath)
    ) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The comparison paths must be absolute.",
      );
    }
    try {
      return createSuccessResponse(requestId, {
        type: "repository.watchedSaveCompared",
        same: await compareWatchedSave({
          repoPath: commandResult.data.repoPath,
          savePath: commandResult.data.savePath,
        }),
      });
    } catch {
      writeDiagnostic("Watched Save comparison failed.");
      return createFailureResponse(
        requestId,
        "repository_watched_save_compare_failed",
        "The repository's Watched Save could not be compared.",
      );
    }
  }

  async function migrateRepository(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = repositoryMigrateCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.migrate command is invalid.",
      );
    }
    if (!path.isAbsolute(commandResult.data.repoPath)) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository path must be absolute.",
      );
    }
    if (session?.access === "readOnly") {
      return createFailureResponse(
        requestId,
        "repository_migrate_failed",
        "Archived repositories are read-only and cannot migrate.",
      );
    }

    try {
      return createSuccessResponse(requestId, {
        type: "repository.migrationResult",
        migration: toProtocolMigration(
          await migrateSaveHistoryRepository(commandResult.data),
        ),
      });
    } catch {
      writeDiagnostic("Repository migration failed.");
      return createFailureResponse(
        requestId,
        "repository_migrate_failed",
        "The Save History Repository could not be migrated.",
      );
    }
  }

  async function archiveRepository(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = repositoryArchiveCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.archive command is invalid.",
      );
    }
    const { sourcePath, targetPath } = commandResult.data;
    if (!path.isAbsolute(sourcePath) || !path.isAbsolute(targetPath)) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository archive paths must be absolute.",
      );
    }
    if (
      session !== undefined
      || preparedMigration !== undefined
      || pendingReplacement !== undefined
    ) {
      return createFailureResponse(
        requestId,
        "repository_archive_failed",
        "The sidecar must not own a session or migration while archiving.",
      );
    }

    try {
      return createSuccessResponse(requestId, {
        type: "repository.archiveResult",
        archive: toProtocolArchiveResult(
          await relocateRepository({ sourcePath, targetPath }),
        ),
      });
    } catch {
      writeDiagnostic("Repository archive move failed.");
      return createFailureResponse(
        requestId,
        "repository_archive_failed",
        "The repository could not be archived.",
      );
    }
  }

  async function prepareRepositoryMigration(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult =
      repositoryMigrationPrepareCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.migration.prepare command is invalid.",
      );
    }
    if (
      !path.isAbsolute(commandResult.data.repoPath)
      || !path.isAbsolute(commandResult.data.snapshotPath)
    ) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository migration paths must be absolute.",
      );
    }
    if (session?.access === "readOnly") {
      return createFailureResponse(
        requestId,
        "repository_migrate_failed",
        "Archived repositories are read-only and cannot migrate.",
      );
    }
    if (preparedMigration !== undefined) {
      return createFailureResponse(
        requestId,
        "repository_migration_not_prepared",
        "A Desktop repository migration is already in progress.",
      );
    }
    if (pendingReplacement !== undefined) {
      return createFailureResponse(
        requestId,
        "repository_migration_not_prepared",
        "A managed repository replacement is already in progress.",
      );
    }

    emitEvent({
      type: "mutation.activity",
      mutation: "repositoryMigration",
      status: "started",
    });
    let preparation: PrepareSaveHistoryMigrationResult;
    try {
      preparation = await prepareSaveHistoryMigration(commandResult.data);
    } catch {
      emitEvent({
        type: "mutation.activity",
        mutation: "repositoryMigration",
        status: "finished",
      });
      writeDiagnostic("Repository snapshot preparation failed.");
      return createFailureResponse(
        requestId,
        "repository_migrate_failed",
        "The repository snapshot could not be created.",
      );
    }
    if (preparation.status === "prepared") {
      preparedMigration = preparation.operation;
    } else {
      emitEvent({
        type: "mutation.activity",
        mutation: "repositoryMigration",
        status: "finished",
      });
    }

    return createSuccessResponse(requestId, {
      type: "repository.migrationPrepared",
      preparation: toProtocolMigrationPreparation(preparation),
    });
  }

  async function commitRepositoryMigration(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    if (!repositoryMigrationCommitCommandSchema.safeParse(command).success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.migration.commit command is invalid.",
      );
    }
    const operation = preparedMigration;
    if (operation === undefined) {
      return createFailureResponse(
        requestId,
        "repository_migration_not_prepared",
        "No prepared Desktop repository migration is available.",
      );
    }

    try {
      const migration = await operation.commit();
      return createSuccessResponse(requestId, {
        type: "repository.migrationResult",
        migration: toProtocolMigration(migration),
      });
    } catch {
      writeDiagnostic("Repository migration commit failed.");
      return createFailureResponse(
        requestId,
        "repository_migrate_failed",
        "The Save History Repository could not be migrated.",
      );
    } finally {
      preparedMigration = undefined;
      emitEvent({
        type: "mutation.activity",
        mutation: "repositoryMigration",
        status: "finished",
      });
    }
  }

  async function prepareRepositoryReplacement(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult =
      repositoryReplacementPrepareCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.replacement.prepare command is invalid.",
      );
    }

    const { operationId, sourcePath, targetPath, expectedWatchedSavePath } =
      commandResult.data;
    if (
      !path.isAbsolute(sourcePath)
      || !path.isAbsolute(targetPath)
      || !path.isAbsolute(expectedWatchedSavePath)
    ) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository replacement paths must be absolute.",
      );
    }
    if (completedReplacement?.operationId === operationId) {
      return createFailureResponse(
        requestId,
        "repository_replacement_prepare_failed",
        "This replacement operation has already reached a terminal result.",
      );
    }
    if (
      session !== undefined
      || preparedMigration !== undefined
      || pendingReplacement !== undefined
    ) {
      return createFailureResponse(
        requestId,
        "repository_replacement_prepare_failed",
        "The sidecar is busy with another session or mutation.",
      );
    }

    emitEvent({
      type: "mutation.activity",
      mutation: "managedReplacement",
      status: "started",
    });
    let preparation: RepositoryReplacementPreparationResult;
    try {
      preparation = await prepareHistoryRepositoryReplacement({
        sourcePath,
        targetPath,
        expectedWatchedSavePath,
      });
    } catch {
      emitEvent({
        type: "mutation.activity",
        mutation: "managedReplacement",
        status: "finished",
      });
      writeDiagnostic("Managed repository replacement preparation failed.");
      return createFailureResponse(
        requestId,
        "repository_replacement_prepare_failed",
        "The managed repository replacement could not be prepared.",
      );
    }

    if (preparation.status === "prepared") {
      pendingReplacement = {
        operationId,
        operation: preparation.operation,
      };
    } else {
      emitEvent({
        type: "mutation.activity",
        mutation: "managedReplacement",
        status: "finished",
      });
    }

    return createSuccessResponse(requestId, {
      type: "repository.replacementPrepared",
      operationId,
      preparation: toProtocolReplacementPreparation(preparation, operationId),
    });
  }

  async function resolveRepositoryReplacement(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult =
      repositoryReplacementResolveCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.replacement.resolve command is invalid.",
      );
    }

    const { operationId, decision } = commandResult.data;
    if (completedReplacement?.operationId === operationId) {
      return createSuccessResponse(requestId, {
        type: "repository.replacementResolved",
        operationId,
        resolution: completedReplacement.resolution,
      });
    }

    const pending = pendingReplacement;
    if (pending === undefined || pending.operationId !== operationId) {
      return createFailureResponse(
        requestId,
        "repository_replacement_not_prepared",
        "No prepared managed repository replacement matches this operation.",
      );
    }

    try {
      const resolution = await resolvePendingReplacement(
        pending.operation,
        decision,
      );
      pendingReplacement = undefined;
      completedReplacement = { operationId, resolution };
      emitEvent({
        type: "mutation.activity",
        mutation: "managedReplacement",
        status: "finished",
      });
      return createSuccessResponse(requestId, {
        type: "repository.replacementResolved",
        operationId,
        resolution,
      });
    } catch {
      writeDiagnostic("Managed repository replacement resolution failed.");
      return createFailureResponse(
        requestId,
        "repository_replacement_resolve_failed",
        "The managed repository replacement could not be resolved.",
      );
    }
  }

  async function rebuildRepository(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    const commandResult = repositoryRebuildCommandSchema.safeParse(command);
    if (!commandResult.success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The repository.rebuild command is invalid.",
      );
    }
    if (!path.isAbsolute(commandResult.data.repoPath)) {
      return createFailureResponse(
        requestId,
        "invalid_repo_path",
        "The repository path must be absolute.",
      );
    }
    if (session?.access === "readOnly") {
      return createFailureResponse(
        requestId,
        "repository_rebuild_failed",
        "Archived repositories are read-only and cannot rebuild their Semantic Read Model.",
      );
    }

    emitEvent({
      type: "mutation.activity",
      mutation: "repositoryRebuild",
      status: "started",
    });
    try {
      const rebuild = await rebuildSemanticReadModel({
        repoPath: commandResult.data.repoPath,
      });
      const inspection = await inspectSaveHistoryRepository({
        repoPath: commandResult.data.repoPath,
      });

      return createSuccessResponse(requestId, {
        type: "repository.rebuilt",
        rebuild: toProtocolRebuild(rebuild),
        repository: toProtocolRepositoryStatus(inspection),
      });
    } catch {
      writeDiagnostic("Repository Semantic Read Model rebuild failed.");
      return createFailureResponse(
        requestId,
        "repository_rebuild_failed",
        "The Semantic Read Model could not be rebuilt.",
      );
    } finally {
      emitEvent({
        type: "mutation.activity",
        mutation: "repositoryRebuild",
        status: "finished",
      });
    }
  }

  async function startWatcher(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    if (!watcherStartCommandSchema.safeParse(command).success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The watcher.start command is invalid.",
      );
    }
    if (session === undefined) {
      return createFailureResponse(
        requestId,
        "session_not_open",
        "Open a Repo Session before controlling its watcher.",
      );
    }
    if (session.access === "readOnly") {
      return createFailureResponse(
        requestId,
        "watcher_start_failed",
        "Archived repositories are read-only and cannot control a watcher.",
      );
    }

    try {
      await session.startWatching();
      return createSuccessResponse(requestId, { type: "watcher.started" });
    } catch {
      writeDiagnostic("Watcher start failed.");
      return createFailureResponse(
        requestId,
        "watcher_start_failed",
        "The watcher could not be started.",
      );
    }
  }

  async function stopWatcher(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    if (!watcherStopCommandSchema.safeParse(command).success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The watcher.stop command is invalid.",
      );
    }
    if (session === undefined) {
      return createFailureResponse(
        requestId,
        "session_not_open",
        "Open a Repo Session before controlling its watcher.",
      );
    }
    if (session.access === "readOnly") {
      return createFailureResponse(
        requestId,
        "watcher_stop_failed",
        "Archived repositories are read-only and cannot control a watcher.",
      );
    }

    try {
      await session.stopWatching();
      return createSuccessResponse(requestId, { type: "watcher.stopped" });
    } catch {
      writeDiagnostic("Watcher stop failed.");
      return createFailureResponse(
        requestId,
        "watcher_stop_failed",
        "The watcher could not be stopped.",
      );
    }
  }

  async function shutDown(
    requestId: string,
    command: unknown,
  ): Promise<DesktopSidecarResponse> {
    if (!processShutdownCommandSchema.safeParse(command).success) {
      return createFailureResponse(
        requestId,
        "invalid_command",
        "The process.shutdown command is invalid.",
      );
    }

    if (preparedMigration !== undefined) {
      return createFailureResponse(
        requestId,
        "shutdown_failed",
        "The Desktop sidecar could not shut down while a repository migration is in progress.",
      );
    }
    if (pendingReplacement !== undefined) {
      return createFailureResponse(
        requestId,
        "shutdown_failed",
        "The Desktop sidecar could not shut down while a managed repository replacement is in progress.",
      );
    }

    try {
      await stopOpenSession();
      session = undefined;
      return createSuccessResponse(requestId, {
        type: "process.shutdownComplete",
      });
    } catch {
      writeDiagnostic("Graceful shutdown failed.");
      return createFailureResponse(
        requestId,
        "shutdown_failed",
        "The Desktop sidecar could not shut down gracefully.",
      );
    }
  }

  function handleRepoSessionEvent(event: RepoSessionEvent) {
    const projected = projectRepoSessionEvent(event);
    if (projected !== undefined) {
      emitEvent(projected);
    }
    if (
      event.type === "fatalError"
      && event.error.reason === "httpServerFailure"
    ) {
      requestUnexpectedStop();
    }
  }

  function emitEvent(event: DesktopSidecarEvent) {
    if (commandEvents !== undefined) {
      commandEvents.push(event);
      return;
    }

    enqueueMessage(createEventEnvelope(event));
  }

  async function flushCommandEvents() {
    const events = commandEvents ?? [];
    for (const event of events) {
      await writeMessage(createEventEnvelope(event));
    }
    commandEvents = undefined;
  }

  async function writeMessage(message: DesktopSidecarProducedMessage) {
    enqueueMessage(message);
    await outputTail;
  }

  function enqueueMessage(message: DesktopSidecarProducedMessage) {
    const validMessage = desktopSidecarProducedMessageSchema.parse(message);
    const line = `${JSON.stringify(validMessage)}\n`;
    outputTail = outputTail
      .catch(() => undefined)
      .then(async () => {
        if (!input.output.write(line)) {
          await once(input.output, "drain");
        }
      });
  }

  async function stopSessionAfterUnexpectedExit() {
    try {
      await stopOpenSession();
      session = undefined;
    } catch {
      writeDiagnostic("Repo Session cleanup failed.");
    }
  }

  async function releasePreparedMigrationAfterUnexpectedExit() {
    const operation = preparedMigration;
    preparedMigration = undefined;
    if (operation === undefined) {
      return;
    }

    const cleanupFailure = await operation.release().catch(() => "unknown");
    if (cleanupFailure !== undefined) {
      writeDiagnostic("Repository migration lease cleanup failed.");
    }
  }

  async function releasePreparedReplacementAfterUnexpectedExit() {
    const pending = pendingReplacement;
    pendingReplacement = undefined;
    if (pending === undefined) {
      return;
    }

    const cleanupWarning = await pending.operation
      .release()
      .catch(() => "leaseReleaseFailed" as const);
    if (cleanupWarning !== undefined) {
      writeDiagnostic("Managed repository replacement lease cleanup failed.");
    }
  }

  async function resolvePendingReplacement(
    operation: Extract<
      RepositoryReplacementPreparationResult,
      { readonly status: "prepared" }
    >["operation"],
    decision: "commit" | "rollback",
  ) {
    if (decision === "rollback" && session !== undefined) {
      await stopOpenSession();
      session = undefined;
    }
    return await operation.resolve(decision);
  }

  async function stopOpenSession() {
    if (session !== undefined) {
      await session.stop();
    }
  }

  function writeDiagnostic(message: string) {
    input.diagnostics.write(`[desktop-sidecar] ${message}\n`);
  }
}

async function readReadableRegularFile(
  pathname: string,
): Promise<Uint8Array | undefined> {
  const metadata = await readFileMetadata(pathname);
  if (metadata?.isFile() !== true) {
    return undefined;
  }

  try {
    return await readFile(pathname);
  } catch {
    return undefined;
  }
}

async function readFileMetadata(pathname: string) {
  try {
    return await stat(pathname);
  } catch {
    return undefined;
  }
}

function decodeSave(
  encodedSave: Uint8Array,
):
  | { readonly decodedSave: unknown; readonly ok: true }
  | { readonly ok: false } {
  try {
    return {
      decodedSave: decodeEncodedSave(encodedSave).decodedSave,
      ok: true,
    };
  } catch {
    return { ok: false };
  }
}

function toProtocolInspection(inspection: SaveHistoryRepositoryInspection) {
  return {
    ...inspection,
    capabilities: [...inspection.capabilities],
  };
}

function toProtocolArchiveResult(result: RelocateRepositoryResult) {
  if (result.status === "relocated") {
    return {
      status: "archived" as const,
      repoPath: result.destinationPath,
      name: path.basename(result.destinationPath),
    };
  }

  return result;
}

function toProtocolMigration(result: MigrateSaveHistoryRepositoryResult) {
  if (result.status !== "migrated") {
    return result;
  }

  return {
    ...result,
    inspection: toProtocolInspection(result.inspection),
  };
}

function toProtocolMigrationPreparation(
  result: PrepareSaveHistoryMigrationResult,
) {
  if (result.status !== "prepared") {
    return result;
  }

  return {
    status: "prepared" as const,
    snapshot: result.operation.snapshot,
  };
}

function toProtocolReplacementPreparation(
  result: RepositoryReplacementPreparationResult,
  operationId: string,
) {
  if (result.status !== "prepared") {
    return result;
  }

  return {
    status: "prepared" as const,
    operationId,
    destinationPath: result.operation.destinationPath,
    sourceStatus: result.sourceStatus,
  };
}

function toProtocolRebuild(result: RebuildSemanticReadModelResult) {
  return { ...result };
}

function toProtocolRepositoryStatus(
  inspection: SaveHistoryRepositoryInspection,
) {
  return {
    status: inspection.status,
    requiredAction: inspection.requiredAction,
    capabilities: [...inspection.capabilities],
  };
}

function projectRepoSessionEvent(
  event: RepoSessionEvent,
): DesktopSidecarEvent | undefined {
  if (event.type === "mutationActivity") {
    return {
      type: "mutation.activity",
      mutation: event.mutation,
      status: event.status,
    };
  }
  if (event.type === "observation") {
    const { result } = event;
    if (result.status === "committed") {
      return {
        type: "watcher.observation",
        cause: event.cause,
        status: "committed",
        eventCount:
          result.semanticUpdate.status === "updated"
            ? result.semanticUpdate.eventCount
            : 0,
        semanticStatus: result.semanticUpdate.status,
      };
    }
    if (result.status === "skipped") {
      return {
        type: "watcher.observation",
        cause: event.cause,
        status: "skipped",
        reason: result.reason,
      };
    }

    return {
      type: "watcher.observation",
      cause: event.cause,
      status: "watcherError",
      reason: result.error.reason,
    };
  }

  if (event.type === "fatalError") {
    return event.error.reason === "watchBackendFailure"
      ? { type: "watcher.failed", reason: "watchBackendFailure" }
      : { type: "session.failed", reason: "httpServerFailure" };
  }

  return undefined;
}
