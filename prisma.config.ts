import { defineConfig, env } from "prisma/config";
import { config } from "dotenv";

// The CLI boots outside Next.js, so it loads .env.local itself.
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations and introspection bypass the pooler; the app uses the pooled
    // URL via the driver adapter in src/lib/db.ts.
    url: env("DIRECT_URL"),
  },
});
