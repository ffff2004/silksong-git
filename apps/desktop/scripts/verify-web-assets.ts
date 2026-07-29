import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const desktopAssetsDirectory = path.resolve(
  import.meta.dirname,
  "../../web/dist-desktop",
);
const indexPath = path.join(desktopAssetsDirectory, "index.html");
const indexHtml = await readFile(indexPath, "utf8");
const normalizedIndexHtml = indexHtml.replaceAll(/\s+/gv, " ");

const runtimeAssetUrls = Array.from(
  indexHtml.matchAll(
    /<(?:link|script)\b[^>]+(?:href|src)="(?<url>[^"]+)"[^>]*>/gv,
  ),
  (match) => match.groups?.["url"],
).filter((url): url is string => url !== undefined);

if (runtimeAssetUrls.length === 0) {
  throw new Error("Desktop index does not reference any runtime assets.");
}

for (const url of runtimeAssetUrls) {
  if (
    url.startsWith("http:")
    || url.startsWith("https:")
    || url.startsWith("//")
  ) {
    throw new Error(`Desktop index loads a remote runtime asset: ${url}`);
  }
}

if (
  indexHtml.includes("__SILKSONG_GIT_APP_ENTRY__")
  || indexHtml.includes("__SILKSONG_GIT_COMPOSITION__")
) {
  throw new Error(
    "Desktop index still contains an unresolved composition placeholder.",
  );
}

if (
  !normalizedIndexHtml.includes(
    'name="silksong-git-composition" content="desktop"',
  )
) {
  throw new Error("Desktop index is not marked with the Desktop composition.");
}

const runtimeFiles = await getRuntimeFiles(desktopAssetsDirectory);
const runtimeContents = await Promise.all(
  runtimeFiles.map(async (filePath) => await readFile(filePath, "utf8")),
);

for (const forbiddenHost of [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "unpkg.com",
]) {
  if (runtimeContents.some((contents) => contents.includes(forbiddenHost))) {
    throw new Error(
      `Desktop runtime contains CDN dependency: ${forbiddenHost}`,
    );
  }
}

console.log(
  `Verified ${runtimeAssetUrls.length} bundled references across ${runtimeFiles.length} Desktop runtime files.`,
);

async function getRuntimeFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await getRuntimeFiles(entryPath);
      }

      return /\.(?:css|html|js)$/v.test(entry.name) ? [entryPath] : [];
    }),
  );

  return files.flat();
}
