// Loading env must happen before any module that reads process.env at import
// time (src/lib/db.ts does). ESM hoists imports, so this side-effecting import
// has to come first and the rest are loaded dynamically below.
import "./env.js";

import { createServer } from "node:http";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

/**
 * One HTTP server, two responsibilities: Next.js handles requests, Socket.IO
 * handles the upgrade to WebSocket on the same origin. Sharing the process is
 * what lets presence and the in-memory state live alongside the app (ADR-0001).
 */
async function main() {
  const { attachSocketServer } = await import("./socket.js");

  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error("[next] request failed", error);
      res.statusCode = 500;
      res.end("Internal Server Error");
    });
  });

  attachSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, hostname, resolve);
  });
  console.log(`[server] ready on http://localhost:${port} (dev=${dev})`);

  // Loaded after the server is listening, and deliberately not awaited. The
  // model costs ~74 MB and a few seconds to load (ADR-0007); paying that here
  // means the first person to send an image does not, while starting it after
  // `listen` means health checks are answered during the load rather than
  // after it. `classifyImage` loads on demand if this has not finished, so
  // this is an optimisation rather than a prerequisite.
  const { warmNudityClassifier } = await import("../src/server/moderation/nudity.js");
  warmNudityClassifier()
    .then(() => console.log("[server] nudity classifier ready"))
    .catch((error: unknown) => {
      // Logged, not fatal. The classifier retries its load on the next image,
      // and an image that cannot be classified is refused rather than
      // delivered -- so a failed warm costs latency, never a bypass.
      console.error("[server] warming the nudity classifier failed", error);
    });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, closing`);
    httpServer.close(() => process.exit(0));
    // Don't let a hung connection block the exit indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});
