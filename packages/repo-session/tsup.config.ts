import { defineConfig } from "tsup";

export default defineConfig({
  bundle: true,
  clean: true,
  dts: {
    compilerOptions: { ignoreDeprecations: "6.0", rootDir: "." },
  },
  entry: ["src/index.ts", "src/http-contract.ts", "src/http-wire.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  splitting: false,
  target: "node24",
});
