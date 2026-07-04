import { writeFile } from "node:fs/promises";

import type { CliIo } from "./cli-io.ts";

export function formatJson(
  value: unknown,
  options: { readonly compact?: boolean } = {},
): string {
  const json = JSON.stringify(
    value,
    undefined,
    options.compact === true ? undefined : 2,
  );

  return `${json}\n`;
}

export async function writeJsonOutput(
  output: string,
  outputPath: string | undefined,
  io: CliIo,
): Promise<void> {
  if (outputPath === undefined) {
    io.writeStdout(output);
    return;
  }

  await writeFile(outputPath, output);
}
