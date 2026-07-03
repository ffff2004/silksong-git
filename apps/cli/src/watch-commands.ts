import type {
  LocalHistoryApiProcessEvent,
  ObserveSaveResult,
} from "@silksong-git/history";
import { startLocalHistoryApiProcess } from "@silksong-git/history";
import type { Command } from "commander";

import { exitCodes } from "./exit-codes.ts";
import { formatJson } from "./output.ts";
import { resolveRepositoryContext } from "./repo-context.ts";

interface WatchStartCommandOptions {
  readonly repo?: string;
  readonly jsonl?: boolean;
  readonly http?: boolean;
  readonly port?: string;
}

export function registerWatchCommands(program: Command): void {
  const watchCommand = program.command("watch");

  watchCommand
    .command("start")
    .option("--repo <history-repo>")
    .option("--jsonl")
    .option("--http")
    .option("--port <port>")
    .action(async (options: WatchStartCommandOptions) => {
      await runWatchStartCommand(options);
    });
}

async function runWatchStartCommand(options: WatchStartCommandOptions) {
  if (rejectReservedHttpOptions(options)) {
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
  let stopStarted = false;
  const output = createWatchEventRenderer(options, (target, error) => {
    if (outputState.failed) {
      return;
    }

    outputState.failed = true;
    process.exitCode = 1;

    if (target !== "stderr") {
      writeStderrSafely(`watch output failed: ${getErrorMessage(error)}\n`);
    }

    stopRequest.stop();
  });

  const localHistoryProcess = await startLocalHistoryApiProcess({
    repoPath,
    onEvent: (event) => {
      if (!outputState.failed) {
        output.render(event);
      }

      if (event.type === "fatalError") {
        process.exitCode = 1;
      } else if (event.type === "stopped") {
        stopped.resolve(undefined);
      }
    },
  });

  stopRequest.stop = stop;

  if (outputState.failed) {
    stop();
  }

  function stop() {
    stopProcess().catch((error: unknown) => {
      writeStderrSafely(`watch stop failed: ${getErrorMessage(error)}\n`);
      process.exitCode = 1;
      stopped.resolve(undefined);
    });
  }

  async function stopProcess() {
    if (stopStarted) {
      return;
    }

    stopStarted = true;
    await localHistoryProcess.stop();
  }

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await stopped.promise;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  output.dispose();
}

function rejectReservedHttpOptions(options: WatchStartCommandOptions): boolean {
  if (options.http !== true && options.port === undefined) {
    return false;
  }

  process.stderr.write(
    "error: HTTP Adapter is implemented by P5-T6 and is not available in this command yet\n",
  );
  process.exitCode = exitCodes.usage;

  return true;
}

type WatchOutputTarget = "stdout" | "stderr";

interface WatchEventRenderer {
  render: (event: LocalHistoryApiProcessEvent) => void;
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
    render(event: LocalHistoryApiProcessEvent) {
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

function toJsonlWatchEvent(event: LocalHistoryApiProcessEvent): unknown {
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

function toHumanWatchEvent(event: LocalHistoryApiProcessEvent): string {
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
