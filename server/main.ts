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
