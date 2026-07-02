import { writeFile } from "node:fs/promises";

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
): Promise<void> {
  if (outputPath === undefined) {
    process.stdout.write(output);
    return;
  }

  await writeFile(outputPath, output);
}
