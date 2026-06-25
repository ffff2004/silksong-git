import { includes, isASCII, ReadonlyMap } from "complete-common";
import { readFile } from "complete-node";
import { globby } from "globby";
import path from "node:path";

import { REPO_ROOT } from "./paths.ts";

/**
 * In general, we want to keep non-standard characters out of the codebase. Only certain files are
 * allowed to have non-ASCII characters.
 */
const ALLOWED_UNICODE_MAP = new ReadonlyMap<string, readonly string[]>([
  ["index.html", ["✕"]],
  ["main.ts", ["📋", "❌"]],
  ["overview.md", ["│", "├", "└", "─"]],
  ["progress.ts", ["✕", "↑", "🔒"]],
  ["raw-save.ts", ["📋", "❌"]],
  ["save-data.ts", ["✅", "❌"]],
  ["WhatDidIPickUp.cs", ["’"]],
]);

export async function checkForIllegalCharacters(): Promise<void> {
  const ignoredExtensions = ["otf", "png", "svg", "ttf", "woff2", "dll"];
  const ignoredExtensionsGlob = ignoredExtensions.map(
    (extension) => `**/*.${extension}`,
  );
  const ignore = [
    ...ignoredExtensionsGlob,
    "scripts/lint/illegal-characters.ts",
  ];
  const filePaths = await globby("**", {
    cwd: REPO_ROOT,
    absolute: true,
    gitignore: true,
    ignore,
  });

  const fileInfos = await Promise.all(
    filePaths.map(async (filePath) => ({
      filePath,
      fileContents: await readFile(filePath),
    })),
  );

  for (const fileInfo of fileInfos) {
    const { filePath, fileContents } = fileInfo;

    if (!isASCII(fileContents)) {
      const fileName = path.basename(filePath);
      const allowedEmoji = ALLOWED_UNICODE_MAP.get(fileName) ?? [];
      for (const character of fileContents) {
        if (!isASCII(character) && !includes(allowedEmoji, character)) {
          throw new Error(
            `The character of "${character}" is not allowed in file "${filePath}". Please remove it. Alternatively, if this character is needed, add it to the unicode whitelist in the "illegal-characters.ts" file.`,
          );
        }
      }
    }
  }
}
