import { playwright } from "@vitest/browser-playwright";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

const BASE_PATH = process.env["BASE_PATH"] ?? "/silksong-git/";

export default defineConfig({
  base: BASE_PATH,
  plugins: [solid({ hot: false })],
  test: {
    attachmentsDir: "test-results/attachments",
    include: ["src/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      screenshotDirectory: "test-results/screenshots",
      screenshotFailures: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
