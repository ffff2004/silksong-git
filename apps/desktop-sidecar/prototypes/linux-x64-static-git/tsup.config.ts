import path from "node:path";

import { defineConfig } from "tsup";

const prototypeDirectory = import.meta.dirname;

export default defineConfig({
  bundle: true,
  clean: true,
  entry: {
    "sidecar-entry": path.resolve(prototypeDirectory, "sea-main.ts"),
  },
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      "import.meta.url": "__filename",
    };
  },
  format: ["cjs"],
  noExternal: [
    /^@hono\//v,
    /^@silksong-git\//v,
    "complete-common",
    "crypto-js",
    "hono",
    "zod",
  ],
  outDir: path.resolve(prototypeDirectory, "dist/bundle"),
  platform: "node",
  splitting: false,
  target: "node24",
});
