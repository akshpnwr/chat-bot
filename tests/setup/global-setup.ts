import { execFileSync } from "node:child_process";
import { resolveTestDatabaseUrl } from "./test-database-url";

/**
 * Brings the disposable test branch to the current schema once per run, so a
 * migration added alongside a feature is applied rather than surfacing later as
 * a confusing query failure.
 */
export default function setup() {
  const { url, directUrl } = resolveTestDatabaseUrl();

  try {
    // Captured rather than inherited. Vitest swallows what global setup writes
    // to the terminal, and `execFileSync` attaches nothing to the error it
    // throws, so an inherited stdio fails as `stdout: null, stderr: null` --
    // every migration failure looks identical and says nothing about itself.
    // Holding the output is what lets it be attached to the error below.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: directUrl },
    });
  } catch (cause) {
    const { stdout, stderr } = cause as { stdout?: string; stderr?: string };
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    throw new Error(
      `Migrating the test branch failed.\n\n${detail || "(no output captured)"}`,
      { cause },
    );
  }
}
