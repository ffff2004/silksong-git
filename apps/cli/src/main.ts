#!/usr/bin/env node

import { DecodeEncodedSaveError } from "@silksong-git/core";
import { Command } from "commander";

import { exitCodes } from "./exit-codes.ts";
import { registerRepoCommands } from "./repo-commands.ts";
import { registerSaveCommands } from "./save-commands.ts";

const program = new Command();

program.name("silksong-git");

registerRepoCommands(program);
registerSaveCommands(program);

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof DecodeEncodedSaveError) {
    process.stderr.write("cannot decode save\n");
    process.exitCode = exitCodes.decodeFailure;
  } else {
    throw error;
  }
}
