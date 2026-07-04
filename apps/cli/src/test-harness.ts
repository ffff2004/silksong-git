import { runCli } from "./cli-program.ts";
import type { CliRuntime } from "./cli-runtime.ts";

export interface InProcessCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runCliInProcess(
  args: readonly string[],
): Promise<InProcessCliResult> {
  return await runCliEntryInProcess(["node", "silksong-git", ...args]);
}

export async function runCliEntryInProcess(
  argv: readonly string[],
): Promise<InProcessCliResult> {
  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    writeStdout(output: string) {
      stdout += output;
    },
    writeStderr(output: string) {
      stderr += output;
    },
    setExitCode(code: number) {
      exitCode = code;
    },
  };

  await runCli(argv, runtime);

  return {
    exitCode,
    stdout,
    stderr,
  };
}
