import { config } from "dotenv";

/**
 * Next.js loads .env.local for its own code, but the custom server boots before
 * Next does, so it has to load the file itself.
 */
export function loadEnv() {
  config({ path: ".env.local", quiet: true });
  config({ path: ".env", quiet: true });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
