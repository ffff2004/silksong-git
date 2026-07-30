#!/usr/bin/env node

import { runDesktopSidecarProcess } from "./sidecar-process.ts";

process.exitCode = await runDesktopSidecarProcess({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
});
