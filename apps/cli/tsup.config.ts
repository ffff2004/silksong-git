import { defineConfig } from "tsup";

export default defineConfig({
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  clean: true,
  entry: ["src/main.ts"],
  external: ["@silksong-git/core"],
  format: ["esm"],
  noExternal: [
    /^@hono\//v,
    "@silksong-git/history",
    "@silksong-git/repo-session",
    "complete-common",
    "crypto-js",
    "hono",
    "zod",
  ],
  outDir: "dist",
  platform: "node",
  splitting: false,
  target: "node24",
});
