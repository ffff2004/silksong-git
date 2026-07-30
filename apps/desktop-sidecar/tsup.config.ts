import { defineConfig } from "tsup";

export default defineConfig({
  bundle: true,
  clean: true,
  entry: ["src/main.ts"],
  format: ["esm"],
  noExternal: [
    /^@hono\//v,
    /^@silksong-git\//v,
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
