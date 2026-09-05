import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { auth } from "../src/lib/auth.js";
import {
  assertParticipant,
  NotAParticipantError,
} from "../src/server/authorization.js";
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

/** The room a Conversation broadcasts into. Joined only after the guard passes. */
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function attachSocketServer(httpServer: HttpServer): ChatServer {
  const io: ChatServer = new Server(httpServer, {
    // Socket.IO's own short-gap recovery is the fast path for momentary blips;
    // cursor-based sync (ticket #7) is the real guarantee for longer absences.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: true,
    },
  });

  /**
   * The security spine. The session cookie is verified server-side once, here,
   * and the resulting user id is pinned to the connection for its lifetime.
   * Because no later handler reads a user id from an event payload,
   * impersonation is structurally impossible rather than merely validated
   * against.
   */
  io.use((socket, nextMiddleware) => {
    const cookie = socket.request.headers.cookie;
    if (!cookie) {
      nextMiddleware(new Error("UNAUTHENTICATED"));
      return;
    }

    auth.api
      .getSession({ headers: new Headers({ cookie }) })
      .then((session: Awaited<ReturnType<typeof auth.api.getSession>>) => {
        if (!session?.user?.id) {
          nextMiddleware(new Error("UNAUTHENTICATED"));
          return;
        }
        socket.data.userId = session.user.id;
        nextMiddleware();
      })
      .catch((error: unknown) => {
        console.error("[socket] session verification failed", error);
        nextMiddleware(new Error("UNAUTHENTICATED"));
      });
  });

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    console.log(`[socket] connected ${socket.id} as ${userId}`);

    // A user's own room, so later tickets can reach every tab they have open.
    void socket.join(`user:${userId}`);
    socket.emit("connection:ready", { userId });

    socket.on("ping", (callback) => {
      callback({ ok: true, at: Date.now() });
    });

    socket.on("conversation:join", (payload, callback) => {
      // The guard runs before the join, so a non-member never enters the room
      // and the broadcast primitive itself cannot deliver to them.
      assertParticipant(userId, payload.conversationId)
        .then(async () => {
          await socket.join(conversationRoom(payload.conversationId));
          callback({ ok: true });
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] conversation:join failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnected ${socket.id} (${reason})`);
    });
  });

  return io;
}
