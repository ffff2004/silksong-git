export interface CliIo {
  writeStdout: (output: string) => void;
  writeStderr: (output: string) => void;
}

export interface CliRuntime {
  readonly io: CliIo;
  setExitCode: (code: number) => void;
}

const processCliIo: CliIo = {
  writeStdout(output: string) {
    process.stdout.write(output);
  },
  writeStderr(output: string) {
    process.stderr.write(output);
  },
};

export const processCliRuntime: CliRuntime = {
  io: processCliIo,
  setExitCode(code: number) {
    process.exitCode = code;
  },
};
