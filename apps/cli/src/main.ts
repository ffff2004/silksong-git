#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import type {
  DecodedEncodedSave,
  ParsedDecodedSave,
  SemanticSnapshot,
} from "@silksong-git/core";
import {
  createSemanticSnapshot,
  decodeEncodedSave,
  DecodeEncodedSaveError,
  getBuiltinMappingData,
  parseDecodedSave,
  UnrecognizedSaveSchemaError,
} from "@silksong-git/core";
import { Command } from "commander";

const exitCodes = {
  usage: 1,
  decodeFailure: 2,
  unrecognizedSchema: 3,
} as const;

interface DecodeCommandOptions {
  readonly compact?: boolean;
  readonly out?: string;
  readonly schemaCheck?: boolean;
}

interface SnapshotCommandOptions {
  readonly json?: boolean;
}

const program = new Command();

program.name("silksong-git");

const saveCommand = program.command("save");

saveCommand
  .command("decode")
  .argument("<save.dat>")
  .option("--compact")
  .option("--out <decoded-save.json>")
  .option("--schema-check")
  .action(async (savePath: string, options: DecodeCommandOptions) => {
    await runDecodeCommand(savePath, options);
  });

saveCommand
  .command("snapshot")
  .argument("<save.dat>")
  .option("--json")
  .action(async (savePath: string, options: SnapshotCommandOptions) => {
    await runSnapshotCommand(savePath, options);
  });

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

async function runDecodeCommand(
  savePath: string,
  options: DecodeCommandOptions,
) {
  const decoded = await decodeSaveFile(savePath);
  const output = formatJson(decoded.decodedSave, {
    compact: options.compact === true,
  });

  await writeJsonOutput(output, options.out);

  if (options.schemaCheck === true) {
    reportSchemaCheck(decoded.decodedSave);
  }
}

async function runSnapshotCommand(
  savePath: string,
  options: SnapshotCommandOptions,
) {
  if (options.json !== true) {
    process.stderr.write("save snapshot requires --json\n");
    process.exitCode = exitCodes.usage;
    return;
  }

  const snapshot = await createSnapshotFromSaveFile(savePath);
  if (snapshot === undefined) {
    return;
  }

  process.stdout.write(formatJson(snapshot, { compact: false }));
}

async function decodeSaveFile(savePath: string): Promise<DecodedEncodedSave> {
  return decodeEncodedSave(await readFile(savePath));
}

function formatJson(
  value: unknown,
  options: { readonly compact: boolean },
): string {
  const json = JSON.stringify(
    value,
    undefined,
    options.compact ? undefined : 2,
  );

  return `${json}\n`;
}

async function writeJsonOutput(output: string, outputPath: string | undefined) {
  if (outputPath === undefined) {
    process.stdout.write(output);
    return;
  }

  await writeFile(outputPath, output);
}

function reportSchemaCheck(decodedSave: unknown) {
  try {
    parseDecodedSave(decodedSave);
    process.stderr.write("recognized save schema\n");
  } catch (error) {
    if (error instanceof UnrecognizedSaveSchemaError) {
      process.stderr.write(
        "warning: decoded save does not match a recognized schema\n",
      );
      return;
    }

    throw error;
  }
}

async function createSnapshotFromSaveFile(
  savePath: string,
): Promise<SemanticSnapshot | undefined> {
  const decoded = await decodeSaveFile(savePath);
  const parsedSave = parseSaveForSnapshot(decoded.decodedSave, savePath);
  if (parsedSave === undefined) {
    return undefined;
  }

  return createSemanticSnapshot(parsedSave, getBuiltinMappingData());
}

function parseSaveForSnapshot(
  decodedSave: unknown,
  savePath: string,
): ParsedDecodedSave | undefined {
  try {
    return parseDecodedSave(decodedSave);
  } catch (error) {
    if (error instanceof UnrecognizedSaveSchemaError) {
      process.stderr.write(
        `decoded save does not match a recognized schema\ntry: silksong-git save decode ${savePath}\n`,
      );
      process.exitCode = exitCodes.unrecognizedSchema;
      return undefined;
    }

    throw error;
  }
}
