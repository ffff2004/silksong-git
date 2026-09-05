import { runDesktopSidecarProcess } from "../../src/sidecar-process.ts";

void runDesktopSidecarProcess({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
}).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  () => {
    process.exitCode = 1;
  },
);
