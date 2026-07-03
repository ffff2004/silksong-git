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
  const emit = createWatchEventRenderer(options);

  const localHistoryProcess = await startLocalHistoryApiProcess({
    repoPath,
    onEvent: (event) => {
      emit(event);

      if (event.type === "fatalError") {
        process.exitCode = 1;
      } else if (event.type === "stopped") {
        stopped.resolve(undefined);
      }
    },
  });

  const stop = () => {
    stopProcess().catch((error: unknown) => {
      process.stderr.write(`watch stop failed: ${getErrorMessage(error)}\n`);
      process.exitCode = 1;
      stopped.resolve(undefined);
    });
  };
  const stopProcess = async () => {
    await localHistoryProcess.stop();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await stopped.promise;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
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

function createWatchEventRenderer(options: WatchStartCommandOptions) {
  return (event: LocalHistoryApiProcessEvent) => {
    if (options.jsonl === true) {
      process.stdout.write(
        formatJson(toJsonlWatchEvent(event), { compact: true }),
      );
      return;
    }

    process.stderr.write(toHumanWatchEvent(event));
  };
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
