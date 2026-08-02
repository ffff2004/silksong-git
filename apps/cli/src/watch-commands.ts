import type { ObserveSaveResult } from "@silksong-git/history";
import { SaveHistoryWatcherAlreadyAcquiredError } from "@silksong-git/history";
import type { RepoSession, RepoSessionEvent } from "@silksong-git/repo-session";
import {
  openRepoSession,
  RepoSessionHttpServerStartError,
} from "@silksong-git/repo-session";
import type { Command } from "commander";

import type { CliRuntime } from "./cli-runtime.ts";
import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";
import { resolveRepositoryContext } from "./repo-context.ts";
import { formatSemanticUpdate } from "./semantic-event-output.ts";

interface WatchStartCommandOptions {
  readonly repo?: string;
  readonly jsonl?: boolean;
  readonly http?: boolean;
  readonly port?: string;
}

export function registerWatchCommands(
  program: Command,
  runtime: CliRuntime,
): void {
  const watchCommand = program.command("watch");

  watchCommand
    .command("start")
    .option("--repo <history-repo>")
    .option("--jsonl")
    .option("--http")
    .option("--port <port>")
    .action(async (options: WatchStartCommandOptions) => {
      await runWatchStartCommand(options, runtime);
    });
}

async function runWatchStartCommand(
  options: WatchStartCommandOptions,
  runtime: CliRuntime,
) {
  const parsedPort = parseHttpOptions(options, runtime);

  if (parsedPort === false) {
    return;
  }
  const port: number | undefined = parsedPort;

  const repoPath = await resolveRepositoryContext({
    explicitRepoPath: options.repo,
  });
  const stopped = Promise.withResolvers<undefined>();
  const outputState = {
    failed: false,
  };
  const stopRequest: { stop: () => void } = {
    stop: () => undefined,
  };
  let repoSession: RepoSession | undefined;
  let watcherStarted = false;
  const stopState = {
    requested: false,
    started: false,
  };
  const output = createWatchEventRenderer(
    options,
    () => repoSession?.http,
    (target, error) => {
      if (outputState.failed) {
        return;
      }

      outputState.failed = true;
      runtime.setExitCode(1);

      if (target !== "stderr") {
        writeStderrSafely(`watch output failed: ${getErrorMessage(error)}\n`);
      }

      stopRequest.stop();
    },
  );

  stopRequest.stop = stop;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGBREAK", stop);

  try {
    await runStartedWatchProcess().catch(handleWatchStartError);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGBREAK", stop);
    output.dispose();
  }

  function handleWatchStartError(error: unknown) {
    if (
      error instanceof RepoSessionHttpServerStartError
      || error instanceof SaveHistoryWatcherAlreadyAcquiredError
    ) {
      runtime.writeStderr(`error: ${error.message}\n`);
      runtime.setExitCode(1);
      return;
    }

    throw error;
  }

  async function runStartedWatchProcess() {
    repoSession = await openRepoSession({
      repoPath,
      ...(port !== undefined && { port }),
      onEvent: (event) => {
        if (event.type === "started") {
          watcherStarted = true;
        }
        if (!outputState.failed && watcherStarted) {
          output.render(event);
        }

        if (event.type === "fatalError") {
          runtime.setExitCode(1);
          stopRequest.stop();
        } else if (event.type === "stopped") {
          stopped.resolve(undefined);
        }
      },
    });
    if (outputState.failed || stopState.requested) {
      stop();
      await stopped.promise;
      return;
    }
    try {
      await repoSession.startWatching();
    } catch (error) {
      await repoSession.stop();
      throw error;
    }

    if (shouldStopAfterWatcherStart()) {
      stop();
    }

    await stopped.promise;
  }

  function shouldStopAfterWatcherStart() {
    return outputState.failed || stopState.requested;
  }

  function stop() {
    stopState.requested = true;

    if (repoSession === undefined) {
      return;
    }

    stopProcess().catch((error: unknown) => {
      writeStderrSafely(`watch stop failed: ${getErrorMessage(error)}\n`);
      runtime.setExitCode(1);
      stopped.resolve(undefined);
    });
  }

  async function stopProcess() {
    const process = repoSession;

    if (stopState.started || process === undefined) {
      return;
    }

    stopState.started = true;
    await process.stop();
  }
}

function parseHttpOptions(
  options: WatchStartCommandOptions,
  runtime: CliRuntime,
): false | number | undefined {
  if (options.port !== undefined && options.http !== true) {
    runtime.writeStderr("error: --port requires --http\n");
    runtime.setExitCode(exitCodes.usage);

    return false;
  }

  if (options.port === undefined) {
    return undefined;
  }

  if (!/^\d+$/v.test(options.port)) {
    runtime.writeStderr("error: --port must be an integer from 1 to 65535\n");
    runtime.setExitCode(exitCodes.usage);

    return false;
  }

  const port = Number(options.port);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    runtime.writeStderr("error: --port must be an integer from 1 to 65535\n");
    runtime.setExitCode(exitCodes.usage);

    return false;
  }

  return port;
}

type WatchOutputTarget = "stdout" | "stderr";

interface WatchEventRenderer {
  render: (event: RepoSessionEvent) => void;
  dispose: () => void;
}

function createWatchEventRenderer(
  options: WatchStartCommandOptions,
  getHttp: () => RepoSession["http"] | undefined,
  onFailure: (target: WatchOutputTarget, error: unknown) => void,
): WatchEventRenderer {
  const onStdoutError = (error: unknown) => {
    onFailure("stdout", error);
  };
  const onStderrError = (error: unknown) => {
    onFailure("stderr", error);
  };

  process.stdout.on("error", onStdoutError);
  process.stderr.on("error", onStderrError);

  return {
    render(event: RepoSessionEvent) {
      const disclosedHttp = options.http === true ? getHttp() : undefined;

      if (options.jsonl === true) {
        const renderedEvent = formatJson(
          toJsonlWatchEvent(event, disclosedHttp),
          { compact: true },
        );
        writeWatchOutput("stdout", renderedEvent, onFailure);
        return;
      }

      const renderedEvent = withWatchTimestamp(
        toHumanWatchEvent(event, disclosedHttp),
        new Date(),
      );
      writeWatchOutput("stderr", renderedEvent, onFailure);
    },
    dispose() {
      process.stdout.off("error", onStdoutError);
      process.stderr.off("error", onStderrError);
    },
  };
}

function writeWatchOutput(
  target: WatchOutputTarget,
  output: string,
  onFailure: (target: WatchOutputTarget, error: unknown) => void,
) {
  try {
    getOutputStream(target).write(output);
  } catch (error) {
    onFailure(target, error);
  }
}

function getOutputStream(target: WatchOutputTarget) {
  return target === "stdout" ? process.stdout : process.stderr;
}

function writeStderrSafely(output: string) {
  try {
    process.stderr.write(output);
  } catch {
    // Ignore secondary diagnostic failures while handling a primary output failure.
  }
}

function toJsonlWatchEvent(
  event: RepoSessionEvent,
  http?: RepoSession["http"],
): unknown {
  switch (event.type) {
    case "started": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        watchedSavePath: event.watchedSavePath,
        capturePolicy: event.capturePolicy,
        ...(http !== undefined && { http }),
      };
    }

    case "observation": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        cause: event.cause,
        ...summarizeObservationResult(event.result),
      };
    }

    case "fatalError": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        reason: event.error.reason,
        message: event.error.message,
      };
    }

    case "httpRequestError": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        ...event.error,
      };
    }

    case "mutationActivity": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        mutation: event.mutation,
        status: event.status,
      };
    }

    case "stopping":
    case "stopped": {
      return {
        type: event.type,
        repoPath: event.repoPath,
      };
    }
  }
}

function summarizeObservationResult(result: ObserveSaveResult) {
  switch (result.status) {
    case "committed": {
      return {
        status: result.status,
        commit: result.observation.commit.shortRef,
      };
    }

    case "skipped": {
      return {
        status: result.status,
        reason: result.reason,
      };
    }

    case "watcherError": {
      return {
        status: result.status,
        reason: result.error.reason,
        message: result.error.message,
      };
    }
  }
}

function toHumanWatchEvent(
  event: RepoSessionEvent,
  httpConnection?: RepoSession["http"],
): string {
  switch (event.type) {
    case "started": {
      const http =
        httpConnection === undefined
          ? ""
          : `http endpoint: ${httpConnection.endpoint}\nhttp token: ${httpConnection.token}\n`;

      return `watch started\nrepo: ${event.repoPath}\nsave: ${event.watchedSavePath}\n${http}`;
    }

    case "observation": {
      return formatHumanWatchObservation(event);
    }

    case "fatalError": {
      return `watch fatal error: ${event.error.message}\n`;
    }

    case "httpRequestError": {
      return `http request error: ${event.error.status} ${event.error.code} ${event.error.message}\n`;
    }

    case "mutationActivity": {
      return `${event.mutation} ${event.status}\n`;
    }

    case "stopping": {
      return "watch stopping\n";
    }

    case "stopped": {
      return "watch stopped\n";
    }
  }
}

function withWatchTimestamp(output: string, now: Date): string {
  return `[${formatWatchTimestamp(now)}] ${output}`;
}

function formatWatchTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / 60);
  const offsetRemainderMinutes = absoluteOffsetMinutes % 60;

  return `${date.getFullYear().toString().padStart(4, "0")}-${formatTimestampPart(
    date.getMonth() + 1,
  )}-${formatTimestampPart(date.getDate())}T${formatTimestampPart(
    date.getHours(),
  )}:${formatTimestampPart(date.getMinutes())}:${formatTimestampPart(
    date.getSeconds(),
  )}.${date.getMilliseconds().toString().padStart(3, "0")}${offsetSign}${formatTimestampPart(
    offsetHours,
  )}:${formatTimestampPart(offsetRemainderMinutes)}`;
}

function formatTimestampPart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatHumanWatchObservation(
  event: Extract<RepoSessionEvent, { readonly type: "observation" }>,
): string {
  const { result } = event;

  switch (result.status) {
    case "committed": {
      return `watch observation ${event.cause}: committed\ncommit: ${result.observation.commit.shortRef}\n${formatSemanticUpdate(result.semanticUpdate)}`;
    }

    case "skipped": {
      return `watch observation ${event.cause}: skipped ${result.reason}\n${
        result.reason === "minimumCommitInterval"
          ? `next: ${result.nextAllowedAt}\n`
          : ""
      }`;
    }

    case "watcherError": {
      return `watch observation ${event.cause}: watcherError ${result.error.reason}\nmessage: ${result.error.message}\n`;
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
