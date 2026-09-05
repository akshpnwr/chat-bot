import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Resolves the disposable branch the suite is allowed to wipe.
 *
 * The suite truncates whatever it connects to, so refusing to start without an
 * explicit TEST_DATABASE_URL is what keeps a stray run from destroying the
 * development database.
 */
export function resolveTestDatabaseUrl(): { url: string; directUrl: string } {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a disposable Postgres branch; " +
        "they refuse to run against DATABASE_URL.",
    );
  }
  return { url, directUrl: process.env.TEST_DIRECT_URL ?? url };
}
