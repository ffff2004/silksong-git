import type {
  LocalHistoryWatchProcess,
  LocalHistoryWatchProcessEvent,
  ObserveSaveResult,
} from "@silksong-git/history";
import {
  LocalHistoryWatchProcessAlreadyRunningError,
  LocalHttpServerStartError,
  startLocalHistoryWatchProcess,
} from "@silksong-git/history";
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
  const http = parseHttpOptions(options, runtime);

  if (http === false) {
    return;
  }
  const httpOptions: { readonly port?: number } | undefined = http;

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
  let localHistoryProcess: LocalHistoryWatchProcess | undefined;
  const stopState = {
    requested: false,
    started: false,
  };
  const output = createWatchEventRenderer(options, (target, error) => {
    if (outputState.failed) {
      return;
    }

    outputState.failed = true;
    runtime.setExitCode(1);

    if (target !== "stderr") {
      writeStderrSafely(`watch output failed: ${getErrorMessage(error)}\n`);
    }

    stopRequest.stop();
  });

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
      error instanceof LocalHttpServerStartError
      || error instanceof LocalHistoryWatchProcessAlreadyRunningError
    ) {
      runtime.writeStderr(`error: ${error.message}\n`);
      runtime.setExitCode(1);
      return;
    }

    throw error;
  }

  async function runStartedWatchProcess() {
    localHistoryProcess = await startLocalHistoryWatchProcess({
      repoPath,
      ...(httpOptions !== undefined && { http: httpOptions }),
      onEvent: (event) => {
        if (!outputState.failed) {
          output.render(event);
        }

        if (event.type === "fatalError") {
          runtime.setExitCode(1);
        } else if (event.type === "stopped") {
          stopped.resolve(undefined);
        }
      },
    });

    if (outputState.failed || stopState.requested) {
      stop();
    }

    await stopped.promise;
  }

  function stop() {
    stopState.requested = true;

    if (localHistoryProcess === undefined) {
      return;
    }

    stopProcess().catch((error: unknown) => {
      writeStderrSafely(`watch stop failed: ${getErrorMessage(error)}\n`);
      runtime.setExitCode(1);
      stopped.resolve(undefined);
    });
  }

  async function stopProcess() {
    const process = localHistoryProcess;

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
): false | { readonly port?: number } | undefined {
  if (options.port !== undefined && options.http !== true) {
    runtime.writeStderr("error: --port requires --http\n");
    runtime.setExitCode(exitCodes.usage);

    return false;
  }

  if (options.http !== true) {
    return undefined;
  }

  if (options.port === undefined) {
    return {};
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

  return { port };
}

type WatchOutputTarget = "stdout" | "stderr";

interface WatchEventRenderer {
  render: (event: LocalHistoryWatchProcessEvent) => void;
  dispose: () => void;
}

function createWatchEventRenderer(
  options: WatchStartCommandOptions,
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
    render(event: LocalHistoryWatchProcessEvent) {
      if (options.jsonl === true) {
        writeWatchOutput(
          "stdout",
          formatJson(toJsonlWatchEvent(event), { compact: true }),
          onFailure,
        );
        return;
      }

      writeWatchOutput(
        "stderr",
        withWatchTimestamp(toHumanWatchEvent(event), new Date()),
        onFailure,
      );
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

function toJsonlWatchEvent(event: LocalHistoryWatchProcessEvent): unknown {
  switch (event.type) {
    case "started": {
      return {
        type: event.type,
        repoPath: event.repoPath,
        watchedSavePath: event.watchedSavePath,
        capturePolicy: event.capturePolicy,
        ...(event.http !== undefined && { http: event.http }),
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

function toHumanWatchEvent(event: LocalHistoryWatchProcessEvent): string {
  switch (event.type) {
    case "started": {
      const http =
        event.http === undefined
          ? ""
          : `http endpoint: ${event.http.endpoint}\nhttp token: ${event.http.token}\n`;

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
  event: Extract<
    LocalHistoryWatchProcessEvent,
    { readonly type: "observation" }
  >,
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
