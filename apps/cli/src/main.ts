#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import type { ParsedDecodedSave } from "@silksong-git/core";
import {
  createSemanticSnapshot,
  decodeEncodedSave,
  DecodeEncodedSaveError,
  getBuiltinMappingData,
  parseDecodedSave,
  UnrecognizedSaveSchemaError,
} from "@silksong-git/core";
import { Command } from "commander";

const program = new Command();

program.name("silksong-git");

const saveCommand = program.command("save");

saveCommand
  .command("decode")
  .argument("<save.dat>")
  .option("--compact")
  .option("--out <decoded-save.json>")
  .option("--schema-check")
  .action(
    async (
      savePath: string,
      options: {
        readonly compact?: boolean;
        readonly out?: string;
        readonly schemaCheck?: boolean;
      },
    ) => {
      const encodedSave = await readFile(savePath);
      const decoded = decodeEncodedSave(encodedSave);
      const indentation = options.compact === true ? undefined : 2;
      const output = `${JSON.stringify(
        decoded.decodedSave,
        undefined,
        indentation,
      )}\n`;

      if (options.out === undefined) {
        process.stdout.write(output);
      } else {
        await writeFile(options.out, output);
      }

      if (options.schemaCheck === true) {
        try {
          parseDecodedSave(decoded.decodedSave);
          process.stderr.write("recognized save schema\n");
        } catch (error) {
          if (error instanceof UnrecognizedSaveSchemaError) {
            process.stderr.write(
              "warning: decoded save does not match a recognized schema\n",
            );
          } else {
            throw error;
          }
        }
      }
    },
  );

saveCommand
  .command("snapshot")
  .argument("<save.dat>")
  .option("--json")
  .action(async (savePath: string, options: { readonly json?: boolean }) => {
    if (options.json !== true) {
      process.stderr.write("save snapshot requires --json\n");
      process.exitCode = 1;
      return;
    }

    const encodedSave = await readFile(savePath);
    const decoded = decodeEncodedSave(encodedSave);
    let parsedSave: ParsedDecodedSave;
    try {
      parsedSave = parseDecodedSave(decoded.decodedSave);
    } catch (error) {
      if (error instanceof UnrecognizedSaveSchemaError) {
        process.stderr.write(
          `decoded save does not match a recognized schema\ntry: silksong-git save decode ${savePath}\n`,
        );
        process.exitCode = 3;
        return;
      }

      throw error;
    }

    const snapshot = createSemanticSnapshot(
      parsedSave,
      getBuiltinMappingData(),
    );

    process.stdout.write(`${JSON.stringify(snapshot, undefined, 2)}\n`);
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof DecodeEncodedSaveError) {
    process.stderr.write("cannot decode save\n");
    process.exitCode = 2;
  } else {
    throw error;
  }
}
