/// <reference types="vitest" />

import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const BASE_PATH = process.env["BASE_PATH"] ?? "/silksong-git/";

export default defineConfig({
  base: BASE_PATH,
  plugins: [solid()],
  test: {
    environment: "jsdom",
  },
  build: {
    chunkSizeWarningLimit: 700,
  },
});
