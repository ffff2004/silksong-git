import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function setRepositoryFormatVersionFixture(
  repoPath: string,
  repositoryFormatVersion: number | undefined,
): Promise<void> {
  // Fixture construction only: the public migration Interface deliberately does not permit a test
  // to manufacture another durable format.
  const configPath = path.join(repoPath, ".silksong-git/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;

  if (repositoryFormatVersion === undefined) {
    delete config["repositoryFormatVersion"];
  } else {
    config["repositoryFormatVersion"] = repositoryFormatVersion;
  }

  await writeFile(configPath, `${JSON.stringify(config)}\n`);
}
