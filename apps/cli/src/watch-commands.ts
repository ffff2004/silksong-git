import type {
  LocalHistoryWatchProcess,
  LocalHistoryWatchProcessEvent,
  ObserveSaveResult,
} from "@silksong-git/history";
import { startLocalHistoryWatchProcess } from "@silksong-git/history";
import type { Command } from "commander";

import type { CliRuntime } from "./cli-runtime.ts";
import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";
import { resolveRepositoryContext } from "./repo-context.ts";

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
  if (rejectReservedHttpOptions(options, runtime)) {
    return;
  }

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
    await runStartedWatchProcess();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGBREAK", stop);
    output.dispose();
  }

  async function runStartedWatchProcess() {
    localHistoryProcess = await startLocalHistoryWatchProcess({
      repoPath,
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

function rejectReservedHttpOptions(
  options: WatchStartCommandOptions,
  runtime: CliRuntime,
): boolean {
  if (options.http !== true && options.port === undefined) {
    return false;
  }

  runtime.writeStderr(
    "error: HTTP Adapter is implemented by P5-T6 and is not available in this command yet\n",
  );
  runtime.setExitCode(exitCodes.usage);

  return true;
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

      writeWatchOutput("stderr", toHumanWatchEvent(event), onFailure);
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
      return `watch started\nrepo: ${event.repoPath}\nsave: ${event.watchedSavePath}\n`;
    }

    case "observation": {
      return `watch observation ${event.cause}: ${event.result.status}\n`;
    }

    case "fatalError": {
      return `watch fatal error: ${event.error.message}\n`;
    }

    case "stopping": {
      return "watch stopping\n";
    }

    case "stopped": {
      return "watch stopped\n";
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
