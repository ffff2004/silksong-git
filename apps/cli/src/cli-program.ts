import { DecodeEncodedSaveError } from "@silksong-git/core";
import { Command } from "commander";

import type { CliRuntime } from "./cli-io.ts";
import { processCliRuntime } from "./cli-io.ts";
import { exitCodes } from "./exit-codes.ts";
import { registerHistoryCommands } from "./history-commands.ts";
import { registerRepoCommands } from "./repo-commands.ts";
import { registerSaveCommands } from "./save-commands.ts";
import { registerWatchCommands } from "./watch-commands.ts";

function createCliProgram(runtime: CliRuntime = processCliRuntime): Command {
  const program = new Command();

  program.name("silksong-git");

  registerRepoCommands(program, runtime);
  registerSaveCommands(program, runtime);
  registerHistoryCommands(program, runtime);
  registerWatchCommands(program, runtime);

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  runtime: CliRuntime = processCliRuntime,
): Promise<void> {
  const program = createCliProgram(runtime);

  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof DecodeEncodedSaveError) {
      runtime.io.writeStderr("cannot decode save\n");
      runtime.setExitCode(exitCodes.decodeFailure);
      return;
    }

    throw error;
  }
}
