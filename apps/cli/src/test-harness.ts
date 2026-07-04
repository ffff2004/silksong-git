import { CommanderError } from "commander";

import { createCliProgram, runCli } from "./cli-program.ts";

export interface InProcessCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCliInProcess(
  args: readonly string[],
): Promise<InProcessCliResult> {
  return await captureProcessOutput(async () => {
    const program = createCliProgram();

    program.exitOverride();

    try {
      await program.parseAsync(["node", "silksong-git", ...args], {
        from: "node",
      });
    } catch (error) {
      if (error instanceof CommanderError) {
        process.exitCode = error.exitCode;
        return;
      }

      throw error;
    }
  });
}

export async function runCliEntryInProcess(
  argv: readonly string[],
): Promise<InProcessCliResult> {
  return await captureProcessOutput(async () => {
    await runCli(argv);
  });
}

async function captureProcessOutput(
  run: () => Promise<void>,
): Promise<InProcessCliResult> {
  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  process.exitCode = undefined;
  process.stdout.write = captureWrite((chunk: string) => {
    stdout += chunk;
  });
  process.stderr.write = captureWrite((chunk: string) => {
    stderr += chunk;
  });

  try {
    await run();

    const exitCode = getCurrentExitCode();

    return {
      exitCode,
      stdout,
      stderr,
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}

function getCurrentExitCode(): number {
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

function captureWrite(onChunk: (chunk: string) => void) {
  return (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    onChunk(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    }

    if (callback !== undefined) {
      callback();
    }

    return true;
  };
}
