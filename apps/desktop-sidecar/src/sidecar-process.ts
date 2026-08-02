import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import type {
  MigrateSaveHistoryRepositoryResult,
  RebuildSemanticReadModelResult,
  SaveHistoryRepositoryInspection,
} from "@silksong-git/history";
import {
  inspectSaveHistoryRepository,
  migrateSaveHistoryRepository,
  rebuildSemanticReadModel,
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
  repositoryInspectCommandSchema,
  repositoryMigrateCommandSchema,
  repositoryRebuildCommandSchema,
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

      case "repository.migrate": {
        return {
          response: await migrateRepository(
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

  async function stopOpenSession() {
    if (session !== undefined) {
      await session.stop();
    }
  }

  function writeDiagnostic(message: string) {
    input.diagnostics.write(`[desktop-sidecar] ${message}\n`);
  }
}

function toProtocolInspection(inspection: SaveHistoryRepositoryInspection) {
  return {
    ...inspection,
    capabilities: [...inspection.capabilities],
  };
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
