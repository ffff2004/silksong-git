import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { format } from "prettier";

import { createLocalHttpOpenApiDocument } from "../http-contract.ts";

const outputDirectory = path.resolve(
  import.meta.dirname,
  "../../../../docs/generated",
);
const outputPath = path.join(outputDirectory, "local-http-api.openapi.json");
const document = createLocalHttpOpenApiDocument();
const content = await format(JSON.stringify(document), { parser: "json" });

await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, content);

console.log(outputPath);
