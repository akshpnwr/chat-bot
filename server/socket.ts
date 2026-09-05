import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from "../src/lib/socket-events.js";

export type ChatServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export function attachSocketServer(httpServer: HttpServer): ChatServer {
  const io: ChatServer = new Server(httpServer, {
    // Socket.IO's own short-gap recovery is the fast path for momentary blips;
    // cursor-based sync (ticket #7) is the real guarantee for longer absences.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  io.on("connection", (socket) => {
    console.log(`[socket] connected ${socket.id}`);

    socket.on("ping", (callback) => {
      callback({ ok: true, at: Date.now() });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnected ${socket.id} (${reason})`);
    });
  });

  return io;
}
