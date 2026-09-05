import { execFileSync } from "node:child_process";
import { resolveTestDatabaseUrl } from "./test-database-url";

/**
 * Brings the disposable test branch to the current schema once per run, so a
 * migration added alongside a feature is applied rather than surfacing later as
 * a confusing query failure.
 */
export default function setup() {
  const { url, directUrl } = resolveTestDatabaseUrl();

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: directUrl },
  });
}
