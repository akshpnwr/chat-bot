import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration tests run against a real Postgres branch, not a mocked client --
 * the guarantees under test (a unique constraint arbitrating idempotency,
 * a BIGSERIAL producing contiguous pages) live in the database, and a mock
 * would pass while the real constraint breaks.
 */
export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/global-setup.ts"],
    setupFiles: ["./tests/setup/env.ts"],
    include: ["tests/**/*.test.ts"],
    // Every test file shares one Postgres branch, so they run one at a time
    // rather than racing each other's truncations.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
