import { spawn } from "node:child_process";
import path from "node:path";

const NIXPKGS_REVISION = "61b7c44c4073f0b827768aff0049561b5110ea5a";
const GIT_EXPRESSION = `
let
  nixpkgs = (builtins.getFlake "github:NixOS/nixpkgs/${NIXPKGS_REVISION}").outPath;
  pkgs = import nixpkgs {};
  git = pkgs.pkgsStatic.gitMinimal.override {
    doInstallCheck = false;
  };
in
[ git git.src ]
`;

export interface PreparedStaticGit {
  readonly binaryPath: string;
  readonly sourceArchivePath: string;
}

export async function prepareStaticGit(): Promise<PreparedStaticGit> {
  const output = await capture("nix", [
    "build",
    "--impure",
    "--expr",
    GIT_EXPRESSION,
    "--no-link",
    "--print-out-paths",
  ]);
  const storePaths = output.trim().split("\n").filter(Boolean);
  const packagePath = storePaths.find((storePath) =>
    storePath.includes("git-minimal-static"),
  );
  const sourceArchivePath = storePaths.find((storePath) =>
    storePath.endsWith("git-2.54.0.tar.xz"),
  );

  if (packagePath === undefined || sourceArchivePath === undefined) {
    throw new Error(`Nix did not return a store path: ${output}`);
  }

  return {
    binaryPath: path.join(packagePath, "bin/git"),
    sourceArchivePath,
  };
}

async function capture(command: string, args: readonly string[]) {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const chunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const exit = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (exit.code !== 0) {
    throw new Error(
      `${command} failed with ${
        exit.signal ?? `exit code ${String(exit.code)}`
      }`,
    );
  }

  return Buffer.concat(chunks).toString("utf8");
}
