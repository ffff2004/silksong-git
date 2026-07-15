/// <reference types="vitest" />

import type { Plugin } from "vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const BASE_PATH = process.env["BASE_PATH"] ?? "/silksong-git/";

function reloadPublicFiles(): Plugin {
  return {
    apply: "serve",
    configureServer(server) {
      const { publicDir } = server.config;
      server.watcher.add(publicDir);
      server.watcher.on("all", (_event, filePath) => {
        if (filePath === publicDir || filePath.startsWith(`${publicDir}/`)) {
          server.ws.send({ type: "full-reload" });
        }
      });
    },
    name: "reload-public-files",
  };
}

export default defineConfig(({ mode }) => ({
  base: BASE_PATH,
  plugins: [
    solid(mode === "test" ? { hot: false } : undefined),
    reloadPublicFiles(),
  ],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup-local-storage.ts",
  },
  build: {
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 0,
          groups: [
            {
              name: "core-data",
              test: /packages[/\\]core[/\\]src[/\\]data[/\\]/,
              priority: 100,
            },
          ],
        },
      },
    },
  },
}));
