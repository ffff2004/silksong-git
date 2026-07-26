import { defineConfig } from "tsup";

export default defineConfig({
  bundle: true,
  clean: true,
  entry: {
    "sidecar-entry": "prototypes/linux-sidecar/src/main.ts",
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
  outDir: "prototypes/linux-sidecar/dist/bundle",
  platform: "node",
  splitting: false,
  target: "node24",
});
