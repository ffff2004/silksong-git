export interface CliRuntime {
  writeStdout: (output: string) => void;
  writeStderr: (output: string) => void;
  setExitCode: (code: number) => void;
}

export const processCliRuntime: CliRuntime = {
  writeStdout(output: string) {
    process.stdout.write(output);
  },
  writeStderr(output: string) {
    process.stderr.write(output);
  },
  setExitCode(code: number) {
    process.exitCode = code;
  },
};
