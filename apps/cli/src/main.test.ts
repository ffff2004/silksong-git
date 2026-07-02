import { strict as assert } from "node:assert";
import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cliEntryPoint = path.join(repoRoot, "apps/cli/src/main.ts");
const fixtureDirectory = path.join(
  repoRoot,
  "packages/core/src/decode/fixtures",
);
const minimalEncodedSavePath = path.join(
  fixtureDirectory,
  "minimal-valid-save.dat",
);
const unrecognizedEncodedSavePath = path.join(
  fixtureDirectory,
  "unrecognized-schema-save.dat",
);

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  return await new Promise((resolve) => {
    execFile(
      "pnpm",
      ["exec", "tsx", cliEntryPoint, ...args],
      {
        cwd: repoRoot,
      },
      (error: ExecFileException | null, stdout, stderr) => {
        resolve({
          exitCode: getExitCode(error),
          stdout,
          stderr,
        });
      },
    );
  });
}

function getExitCode(error: ExecFileException | null): number {
  if (error === null) {
    return 0;
  }

  return typeof error.code === "number" ? error.code : 1;
}

async function createTempDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "silksong-cli-test-"));

  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  return directory;
}

function parseStdoutJson(result: CliResult): unknown {
  return JSON.parse(result.stdout) as unknown;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

test("repo init creates a Save History Repository with JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    minimalEncodedSavePath,
    "--repo",
    repoPath,
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  const initResult = parseStdoutJson(result) as {
    readonly repoPath?: unknown;
    readonly configPath?: unknown;
  };

  assert.equal(initResult.repoPath, repoPath);
  assert.equal(
    initResult.configPath,
    path.join(repoPath, ".silksong-git/config.json"),
  );
  const config = (await readJsonFile(initResult.configPath)) as {
    readonly watchedSavePath?: unknown;
  };

  assert.equal(config.watchedSavePath, minimalEncodedSavePath);
});

test("repo init refuses an invalid Watched Save path", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");
  const missingSavePath = path.join(tempDirectory, "missing-save.dat");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    missingSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /save path must be readable/v);
});

test("repo init refuses a non-empty repository directory", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const repoPath = path.join(tempDirectory, "history-repo");

  await mkdir(repoPath);
  await writeFile(path.join(repoPath, ".gitkeep"), "");

  const result = await runCli([
    "repo",
    "init",
    "--save",
    minimalEncodedSavePath,
    "--repo",
    repoPath,
  ]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /repository path must be empty/v);
});

test("save decode prints pretty Decoded Save JSON for an Encoded Save", async () => {
  const result = await runCli(["save", "decode", minimalEncodedSavePath]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /\n {2}"playerData": \{/v);
  assert.equal(result.stdout.endsWith("\n"), true);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode can print compact Decoded Save JSON", async () => {
  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--compact",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("\n  "), false);
  assert.equal(result.stdout.endsWith("\n"), true);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode writes Decoded Save JSON to an explicit output file", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const outputPath = path.join(tempDirectory, "decoded-save.json");

  await writeFile(outputPath, "old content\n");

  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--out",
    outputPath,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const decodedSave = (await readJsonFile(outputPath)) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode reports recognized schema without changing JSON output", async () => {
  const result = await runCli([
    "save",
    "decode",
    minimalEncodedSavePath,
    "--schema-check",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /recognized save schema/v);
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: { readonly completionPercentage?: unknown };
  };

  assert.equal(decodedSave.playerData?.completionPercentage, 39);
});

test("save decode reports unrecognized schema without blocking raw JSON output", async () => {
  const result = await runCli([
    "save",
    "decode",
    unrecognizedEncodedSavePath,
    "--schema-check",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: decoded save does not match a recognized schema/v,
  );
  const decodedSave = parseStdoutJson(result) as {
    readonly playerData?: unknown;
  };

  assert.equal(typeof decodedSave.playerData, "object");
});

test("save decode reports decode failures without JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));

  const result = await runCli(["save", "decode", invalidSavePath]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot decode save/v);
});

test("save snapshot prints SemanticSnapshot JSON for an Encoded Save", async () => {
  const result = await runCli([
    "save",
    "snapshot",
    minimalEncodedSavePath,
    "--json",
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.endsWith("\n"), true);
  const snapshot = parseStdoutJson(result) as {
    readonly items: readonly unknown[];
    readonly summary: { readonly completionPercentage?: unknown };
    readonly version: {
      readonly saveSchemaVersion: unknown;
      readonly semanticCoreVersion: unknown;
    };
  };

  assert.ok(snapshot.items.length > 0);
  assert.equal(snapshot.summary.completionPercentage, 39);
  assert.equal(snapshot.version.saveSchemaVersion, "silksong-save-v1");
  assert.equal(snapshot.version.semanticCoreVersion, "core-semantic-v1");
});

test("save snapshot requires JSON output mode", async () => {
  const result = await runCli(["save", "snapshot", minimalEncodedSavePath]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires --json/v);
});

test("save snapshot suggests raw decode when schema is unrecognized", async () => {
  const result = await runCli([
    "save",
    "snapshot",
    unrecognizedEncodedSavePath,
    "--json",
  ]);

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /decoded save does not match a recognized schema/v,
  );
  assert.match(result.stderr, /save decode .*unrecognized-schema-save\.dat/v);
});

test("save snapshot reports decode failures without JSON output", async (t) => {
  const tempDirectory = await createTempDirectory(t);
  const invalidSavePath = path.join(tempDirectory, "invalid-save.dat");

  await writeFile(invalidSavePath, new Uint8Array([1, 2, 3, 4]));

  const result = await runCli(["save", "snapshot", invalidSavePath, "--json"]);

  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cannot decode save/v);
});
