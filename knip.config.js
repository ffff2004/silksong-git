// This is the configuration file for Knip:
// https://knip.dev/overview/configuration

// @ts-check

/** @type {import("knip").KnipConfig} */
const config = {
  eslint: {
    config: ["eslint.config.mjs", "eslint.config.json.mjs"],
  },
  ignoreBinaries: ["podman"],
  ignoreDependencies: [
    "@tsconfig/node-lts", // This is resolved through complete-tsconfig's Node preset.
    "@tsconfig/strictest", // This is resolved through complete-tsconfig's base preset.
    "ajv-cli", // This is used by the lint script.
    "ajv-formats", // This is used by the lint script.
    "complete-lint", // This is a linting meta-package.
    "npm", // This is spawned by the CLI package verification script.
    "postject", // This is spawned by the SEA prototype build script.
  ],
  workspaces: {
    "apps/desktop-sidecar": {
      entry: [
        "prototypes/linux-x64-static-git/sea-main.ts",
        "prototypes/linux-x64-static-git/tsup.config.ts",
      ],
    },
    "apps/web": {
      entry: ["src/main.tsx", "src/desktop-main.tsx"],
    },
  },
};

export default config;
