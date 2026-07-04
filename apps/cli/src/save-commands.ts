import { readFile } from "node:fs/promises";

import type {
  DecodedEncodedSave,
  ParsedDecodedSave,
  SemanticSnapshot,
} from "@silksong-git/core";
import {
  createSemanticSnapshot,
  decodeEncodedSave,
  getBuiltinMappingData,
  parseDecodedSave,
  UnrecognizedSaveSchemaError,
} from "@silksong-git/core";
import type { Command } from "commander";

import type { CliRuntime } from "./cli-runtime.ts";
import { exitCodes } from "./exit-codes.ts";
import { formatJson, writeJsonOutput } from "./output.ts";

interface DecodeCommandOptions {
  readonly compact?: boolean;
  readonly out?: string;
  readonly schemaCheck?: boolean;
}

interface SnapshotCommandOptions {
  readonly json?: boolean;
}

export function registerSaveCommands(
  program: Command,
  runtime: CliRuntime,
): void {
  const saveCommand = program.command("save");

  saveCommand
    .command("decode")
    .argument("<save.dat>")
    .option("--compact")
    .option("--out <decoded-save.json>")
    .option("--schema-check")
    .action(async (savePath: string, options: DecodeCommandOptions) => {
      await runDecodeCommand(savePath, options, runtime);
    });

  saveCommand
    .command("snapshot")
    .argument("<save.dat>")
    .option("--json")
    .action(async (savePath: string, options: SnapshotCommandOptions) => {
      await runSnapshotCommand(savePath, options, runtime);
    });
}

async function runDecodeCommand(
  savePath: string,
  options: DecodeCommandOptions,
  runtime: CliRuntime,
) {
  const decoded = await decodeSaveFile(savePath);
  const output = formatJson(decoded.decodedSave, {
    compact: options.compact === true,
  });

  await writeJsonOutput(output, options.out, runtime);

  if (options.schemaCheck === true) {
    reportSchemaCheck(decoded.decodedSave, runtime);
  }
}

async function runSnapshotCommand(
  savePath: string,
  options: SnapshotCommandOptions,
  runtime: CliRuntime,
) {
  if (options.json !== true) {
    runtime.writeStderr("save snapshot requires --json\n");
    runtime.setExitCode(exitCodes.usage);
    return;
  }

  const snapshot = await createSnapshotFromSaveFile(savePath, runtime);
  if (snapshot === undefined) {
    return;
  }

  runtime.writeStdout(formatJson(snapshot));
}

async function decodeSaveFile(savePath: string): Promise<DecodedEncodedSave> {
  return decodeEncodedSave(await readFile(savePath));
}

function reportSchemaCheck(decodedSave: unknown, runtime: CliRuntime) {
  try {
    parseDecodedSave(decodedSave);
    runtime.writeStderr("recognized save schema\n");
  } catch (error) {
    if (error instanceof UnrecognizedSaveSchemaError) {
      runtime.writeStderr(
        "warning: decoded save does not match a recognized schema\n",
      );
      return;
    }

    throw error;
  }
}

async function createSnapshotFromSaveFile(
  savePath: string,
  runtime: CliRuntime,
): Promise<SemanticSnapshot | undefined> {
  const decoded = await decodeSaveFile(savePath);
  const parsedSave = parseSaveForSnapshot(
    decoded.decodedSave,
    savePath,
    runtime,
  );
  if (parsedSave === undefined) {
    return undefined;
  }

  return createSemanticSnapshot(parsedSave, getBuiltinMappingData());
}

function parseSaveForSnapshot(
  decodedSave: unknown,
  savePath: string,
  runtime: CliRuntime,
): ParsedDecodedSave | undefined {
  try {
    return parseDecodedSave(decodedSave);
  } catch (error) {
    if (error instanceof UnrecognizedSaveSchemaError) {
      runtime.writeStderr(
        `decoded save does not match a recognized schema\ntry: silksong-git save decode ${savePath}\n`,
      );
      runtime.setExitCode(exitCodes.unrecognizedSchema);
      return undefined;
    }

    throw error;
  }
}
