import { spawn } from "node:child_process";

export interface PnpmExecOutput {
  readonly stderr: string;
  readonly stdout: string;
}

export async function runPnpmExec(
  binName: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly stdio?: "inherit" | "pipe";
  },
): Promise<PnpmExecOutput> {
  const stdio = options.stdio ?? "pipe";

  return await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", binName, ...args], {
      stdio,
      cwd: options.cwd,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      reject(addOutput(error, stdoutChunks, stderrChunks));
    });
    child.on("close", (code) => {
      const output = getOutput(stdoutChunks, stderrChunks);

      if (code === 0) {
        resolve(output);
      } else {
        reject(
          Object.assign(
            new Error(`${binName} exited with code ${code}`),
            output,
          ),
        );
      }
    });
  });
}

function addOutput(
  error: Error,
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[],
) {
  return Object.assign(error, getOutput(stdoutChunks, stderrChunks));
}

function getOutput(
  stdoutChunks: readonly Buffer[],
  stderrChunks: readonly Buffer[],
): PnpmExecOutput {
  return {
    stderr: Buffer.concat(stderrChunks).toString(),
    stdout: Buffer.concat(stdoutChunks).toString(),
  };
}
