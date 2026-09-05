import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The browser-driven suite, kept apart from the integration one.
 *
 * Two differences make sharing a config impossible. These tests boot a real
 * server and drive real browsers, so a run takes minutes rather than seconds
 * and does not belong in the loop run on every change. And they sign in as the
 * seeded demo accounts against the development database, where the integration
 * suite truncates its own disposable branch between tests -- pointing these at
 * that branch would delete the accounts they need to log in with.
 */
export default defineConfig({
  test: {
    include: ["tests/browser/**/*.browser.test.ts"],
    // One server on one port, one browser: parallel files would fight over both.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
