import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { auth } from "../src/lib/auth.js";
import {
  assertParticipant,
  NotAParticipantError,
} from "../src/server/authorization.js";
import { MessageStatus } from "@prisma/client";
import { sendMessage } from "../src/server/messages.js";
import { toWireMessage } from "../src/lib/wire.js";
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

    /**
     * A send is one round trip: the Message is Accepted -- durably stored --
     * before the ack returns, so a client that receives `ok` knows the system
     * has taken responsibility for it (CONTEXT.md: Accepted).
     *
     * The broadcast goes to the whole room including the sender, rather than
     * to everyone else. The sender's own tab settles its pending Message from
     * the ack, but its *other* tabs have no ack to settle from, and they need
     * the Message just as the recipient does. Delivering to the room is what
     * makes those two cases one case.
     *
     * The sender id comes from the connection, never the payload, so the
     * Message is attributed to whoever the handshake established.
     */
    socket.on("message:send", (payload, callback) => {
      sendMessage({
        senderId: userId,
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        body: payload.body,
      })
        .then((message) => {
          const wire = toWireMessage(message);
          // The ack always carries the Message back to whoever sent it -- that
          // is how their pending Message settles, and a sender may see their
          // own Message at any status.
          callback({ ok: true, message: wire });

          // The room, however, includes the recipient, so the broadcast is
          // gated on visibility (ADR-0003). Text is written VISIBLE and passes
          // straight through; when #9 starts writing images at PENDING, this is
          // already the gate that holds them back rather than a line somebody
          // has to remember to add.
          if (message.status === MessageStatus.VISIBLE) {
            io.to(conversationRoom(message.conversationId)).emit("message:new", wire);
          }
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] message:send failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnected ${socket.id} (${reason})`);
    });
  });

  return io;
}
