import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { auth } from "../src/lib/auth.js";
import {
  assertParticipant,
  NotAParticipantError,
} from "../src/server/authorization.js";
import { MessageStatus } from "@prisma/client";
import {
  ProhibitedLanguageError,
  sendGifMessage,
  sendImageMessage,
  sendMessage,
  sendStickerMessage,
  syncMessages,
  UnknownStickerError,
} from "../src/server/messages.js";
import { gifProvider } from "../src/server/gifs/provider.js";
import { moderateImageMessage } from "../src/server/moderation/pipeline.js";
import { decodeToTensor } from "../src/server/moderation/decode.js";
import { classifyImage } from "../src/server/moderation/nudity.js";
import { isAttachableKey } from "../src/server/storage.js";
import {
  advanceReadMark,
  correspondentsOf,
  otherParticipantOf,
} from "../src/server/read-marks.js";
import { createPresenceRegistry } from "../src/lib/presence.js";
import { createTypingRegistry } from "../src/lib/typing.js";
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

/** The room every tab a User has open is in, so presence can reach all of them. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
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

  /**
   * Presence and typing, held in process memory rather than in Postgres.
   *
   * Both are derived from live connections (CONTEXT.md: Presence), and live
   * connections exist only in this process (ADR-0001) -- so this is where the
   * truth about them lives. Writing either to the database would create a
   * second copy that a crash leaves permanently wrong: every User online
   * forever, every indicator stuck.
   *
   * Created per server rather than at module scope, so a test can stand up an
   * isolated one instead of inheriting whatever a previous test left behind.
   */
  const presence = createPresenceRegistry();
  const typing = createTypingRegistry();

  /**
   * Tells a User's correspondents that their Presence changed.
   *
   * Addressed to the people who share a Conversation with them rather than
   * broadcast to everyone connected. A global broadcast would tell every
   * signed-in stranger when somebody comes online -- a disclosure nobody asked
   * for, and one whose volume grows with the user base rather than with the
   * Conversations that actually display it.
   *
   * Each correspondent is reached through their own room, so every tab they
   * have open is told, and a correspondent who is offline simply has an empty
   * room -- no delivery to arrange, and nothing to retry. They learn the
   * current answer from the snapshot when they next connect.
   */
  async function announcePresence(userId: string, online: boolean): Promise<void> {
    try {
      const correspondents = await correspondentsOf(userId);
      for (const correspondent of correspondents) {
        io.to(userRoom(correspondent)).emit("presence:changed", { userId, online });
      }
    } catch (error) {
      // Logged rather than rethrown: this runs from connection and disconnect
      // handlers, where a rejection has nowhere to go, and a missed
      // announcement is repaired by the next snapshot rather than being fatal.
      console.error("[socket] announcing presence failed", error);
    }
  }

  /**
   * Tells a Conversation who is typing in it.
   *
   * Each recipient is sent the set minus themselves. A client that was told it
   * was typing would render an indicator for its own keystrokes, so excluding
   * the recipient here is what saves every client from having to remember to.
   */
  function broadcastTyping(conversationId: string): void {
    const typists = typing.typistsIn(conversationId);
    for (const socketInRoom of io.sockets.sockets.values()) {
      if (!socketInRoom.rooms.has(conversationRoom(conversationId))) continue;
      socketInRoom.emit("conversation:typing", {
        conversationId,
        userIds: typists.filter((typist) => typist !== socketInRoom.data.userId),
      });
    }
  }

  /**
   * Classifies one Accepted image and announces whatever was decided.
   *
   * Deliberately not awaited by the send handler. The ack has already gone
   * back, so nothing is waiting on this -- and an inference that takes an
   * unusual amount of time must not hold a socket handler open.
   *
   * Who hears what is the whole of ADR-0003 in four lines. A cleared image
   * goes to the Conversation as an ordinary `message:new`, indistinguishable
   * from any other Message. A refused one goes only to its sender's own room,
   * so the recipient never learns it was attempted -- and the sender's every
   * tab learns why, not just the one that sent it.
   */
  async function classify(
    messageId: string,
    assetKey: string | null,
    senderId: string,
  ): Promise<void> {
    if (assetKey === null) return;

    try {
      const decided = await moderateImageMessage({
        messageId,
        assetKey,
        classify: async (image) => classifyImage(await decodeToTensor(image)),
      });
      const wire = toWireMessage(decided);

      if (decided.status === MessageStatus.VISIBLE) {
        io.to(conversationRoom(decided.conversationId)).emit("message:new", wire);
      }
      // To the sender either way: a clearance settles their pending bubble and
      // a refusal replaces it with a reason. The recipient is told nothing
      // about a refusal, which is what the sender-scoped room is for.
      io.to(userRoom(senderId)).emit("message:moderated", wire);
    } catch (error) {
      // The pipeline turns a bad image into a REJECTED row rather than a
      // throw, so reaching here means the database itself was unreachable.
      // Logged rather than rethrown -- there is no caller to receive it -- and
      // the Message stays PENDING, which is withheld from the recipient by the
      // read model rather than delivered unexamined.
      console.error("[socket] classifying an image failed", error);
    }
  }

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    console.log(`[socket] connected ${socket.id} as ${userId}`);

    // A user's own room, so a broadcast can reach every tab they have open.
    void socket.join(userRoom(userId));
    socket.emit("connection:ready", { userId });

    // Announced only when this is the User's *first* connection. A second tab
    // does not change whether they are online, and saying it did would have
    // the other side's indicator flicker every time somebody opens one.
    if (presence.connected(userId, socket.id)) {
      void announcePresence(userId, true);
    }

    socket.on("ping", (callback) => {
      callback({ ok: true, at: Date.now() });
    });

    /**
     * Answers which of the asked-about Users are online.
     *
     * The answer is intersected with the asker's own correspondents rather
     * than given for whatever ids they sent. Otherwise this would be an oracle
     * for "is this person signed in right now" against any user id in the
     * system -- which the transition broadcast is careful not to be, and which
     * would make the scoping there pointless.
     */
    socket.on("presence:snapshot", (payload, callback) => {
      correspondentsOf(userId)
        .then((correspondents) => {
          const visible = new Set(correspondents);
          callback({
            ok: true,
            online: payload.userIds.filter(
              (asked) => visible.has(asked) && presence.isOnline(asked),
            ),
          });
        })
        .catch((error: unknown) => {
          console.error("[socket] presence:snapshot failed", error);
          // An empty answer rather than a refusal: presence is decoration, and
          // a client that gets nothing shows everybody offline until the next
          // transition rather than breaking the Conversation list.
          callback({ ok: true, online: [] });
        });
    });

    /**
     * Joins the Conversation's room and answers with its live state.
     *
     * The reply carries presence, typing and the other side's Read Mark rather
     * than a bare acknowledgement, because those three are broadcast on
     * transition and a client that joins between transitions would otherwise
     * be blind until the next one -- showing somebody offline for as long as
     * they stay connected. Answering with the state as it stands is what makes
     * a reconnection converge immediately rather than eventually.
     */
    socket.on("conversation:join", (payload, callback) => {
      // The guard runs before the join, so a non-member never enters the room
      // and the broadcast primitive itself cannot deliver to them.
      assertParticipant(userId, payload.conversationId)
        .then(async () => {
          await socket.join(conversationRoom(payload.conversationId));

          const other = await otherParticipantOf(userId, payload.conversationId);
          callback({
            ok: true,
            // `assertParticipant` passed, so the other side is missing only in
            // a half-built Conversation nobody can be present in.
            otherOnline: other ? presence.isOnline(other.userId) : false,
            typing: typing
              .typistsIn(payload.conversationId)
              .filter((typist) => typist !== userId),
            otherLastReadSeq: (other?.lastReadSeq ?? 0n).toString(),
          });
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
     * Advances the reader's Read Mark and tells the Conversation it moved.
     *
     * The mark is written for whoever the handshake established, never for a
     * user id in the payload -- so a client cannot mark somebody else's
     * Conversation as read. Monotonicity is enforced in the write itself
     * rather than here (see `advanceReadMark`), which is what makes two tabs
     * advancing at once safe.
     *
     * The broadcast carries the mark that was actually written, which is not
     * always the one requested: a stale tab asking to move it backwards gets
     * the mark as it stands. Sending what was asked for instead would have the
     * sender's receipt walk backwards even though the stored mark never did.
     */
    socket.on("conversation:read", (payload, callback) => {
      let upTo: bigint;
      try {
        upTo = BigInt(payload.upTo);
      } catch {
        // Parsed rather than trusted (ADR-0006): a malformed Sequence is a
        // refusal, not a throw that takes the connection down.
        callback({ ok: false, error: "INTERNAL" });
        return;
      }

      advanceReadMark({ userId, conversationId: payload.conversationId, upTo })
        .then((lastReadSeq) => {
          const mark = lastReadSeq.toString();
          callback({ ok: true, lastReadSeq: mark });
          // To the whole room, sender included: the reader's own other tabs
          // hold the same unread badge and have nothing else to clear it with.
          io.to(conversationRoom(payload.conversationId)).emit("conversation:read", {
            conversationId: payload.conversationId,
            userId,
            lastReadSeq: mark,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] conversation:read failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    /**
     * Records that somebody is typing, or has stopped.
     *
     * Guarded on room membership rather than by another database round trip:
     * the socket is only in the room because the join above already ran the
     * membership guard, so a non-member cannot announce typing into a
     * Conversation they are not in. Doing it this way keeps a per-keystroke
     * event off the database entirely.
     *
     * Broadcast only when the set of typists actually changed. The client
     * re-announces every few seconds while composing, and rebroadcasting each
     * renewal would re-render the recipient on a timer for no new information.
     */
    socket.on("conversation:typing", (payload) => {
      if (!socket.rooms.has(conversationRoom(payload.conversationId))) return;

      const changed = payload.typing
        ? typing.startedTyping(payload.conversationId, userId)
        : typing.stoppedTyping(payload.conversationId, userId);

      if (changed) broadcastTyping(payload.conversationId);
    });

    /**
     * Fills the gap a disconnection left.
     *
     * The client reports the highest Sequence it holds and gets back precisely
     * what lies above it. This is the durable half of the reconnection story:
     * the transport's own recovery above replays a short in-memory buffer and
     * expires after a couple of minutes, so it cannot be what "no Accepted
     * Message is ever silently lost" rests on. This can, because it reads the
     * database -- a client returning after an hour, or after the server was
     * restarted and its buffers went with it, recovers the same way as one
     * returning after two seconds.
     *
     * A client holding nothing sends null and is given the Conversation from
     * the beginning, drained a page at a time.
     */
    socket.on("conversation:sync", (payload, callback) => {
      // Parsed here rather than trusted: `since` crosses the wire as a string
      // (ADR-0006), and a malformed one must be a refusal rather than a throw
      // that takes the connection down.
      let after: bigint;
      try {
        after = payload.since === null ? 0n : BigInt(payload.since);
      } catch {
        callback({ ok: false, error: "INTERNAL" });
        return;
      }

      syncMessages({
        userId,
        conversationId: payload.conversationId,
        after,
      })
        .then((gap) => {
          callback({
            ok: true,
            messages: gap.messages.map(toWireMessage),
            hasMore: gap.hasMore,
          });
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] conversation:sync failed", error);
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
          // Moderation refused it. The term goes back to the sender -- it is
          // the word they just typed, so it discloses nothing they did not
          // already know, and without it they can only guess at a rewrite.
          // Nothing was written and nothing is broadcast, so the recipient
          // never learns the Message was attempted.
          if (error instanceof ProhibitedLanguageError) {
            callback({ ok: false, error: "PROHIBITED_LANGUAGE", term: error.term });
            return;
          }
          console.error("[socket] message:send failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    /**
     * Accepts an image that is already in quarantine, then classifies it.
     *
     * The ack returns as soon as the Message is stored PENDING, before the
     * image has been looked at. That is ADR-0003's asynchronous path rather
     * than a shortcut: classification costs ~50 ms on the WASM backend
     * (ADR-0007), and holding a send's acknowledgement open for it would make
     * every image send feel like a stall. The sender gets their Message back
     * immediately, renders it pending, and hears the verdict separately.
     *
     * Nothing is broadcast here. A PENDING Message is not VISIBLE, so the gate
     * below the text send would withhold it anyway -- but an image is the case
     * that gate was written for, and the recipient learns of the Message only
     * if and when it clears.
     *
     * The key is validated rather than trusted. A client naming a promoted key
     * would be attaching an object that never passed the check, which is the
     * one way the moderation requirement could be bypassed by calling the API
     * directly.
     */
    socket.on("message:sendImage", (payload, callback) => {
      if (!isAttachableKey(payload.assetKey)) {
        callback({ ok: false, error: "INVALID_ASSET" });
        return;
      }

      // The dimensions only reserve space in the sender's own layout, so a
      // wrong one is a cosmetic problem rather than a security one -- but a
      // NaN or a negative would be stored and rendered as a broken bubble.
      const { assetWidth, assetHeight } = payload;
      if (
        !Number.isInteger(assetWidth) ||
        !Number.isInteger(assetHeight) ||
        assetWidth <= 0 ||
        assetHeight <= 0
      ) {
        callback({ ok: false, error: "INVALID_ASSET" });
        return;
      }

      sendImageMessage({
        senderId: userId,
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        assetKey: payload.assetKey,
        assetWidth,
        assetHeight,
      })
        .then((message) => {
          callback({ ok: true, message: toWireMessage(message) });

          // A retried send returns the Message the first attempt stored, which
          // may already have been ruled on. Re-classifying it would spend an
          // inference to arrive at a decision the WHERE clauses in
          // `visibleImageMessage`/`rejectImageMessage` would then refuse to
          // apply -- so the already-decided case is simply re-announced.
          if (message.status !== MessageStatus.PENDING) {
            io.to(userRoom(userId)).emit("message:moderated", toWireMessage(message));
            return;
          }

          void classify(message.id, message.assetUrl, userId);
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] message:sendImage failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    /**
     * Accepts a GIF the sender named by the provider's id.
     *
     * The id is resolved here rather than trusted, and that round trip is the
     * point of the whole event. What is stored on the Message is the URL the
     * provider answered with, so a GIF can only ever be one the provider
     * indexed -- a client naming a URL directly would be attaching an image
     * that skipped classification entirely, which is the same bypass
     * `isAttachableKey` closes for uploads.
     *
     * Membership is checked before the provider is asked. Resolving first
     * would spend a third-party request on behalf of somebody who is not in
     * the Conversation, which is a small thing to hand a stranger.
     *
     * Unlike an image this is one round trip: the Message is VISIBLE when it
     * is Accepted, so it is broadcast before the ack goes back.
     */
    socket.on("message:sendGif", (payload, callback) => {
      assertParticipant(userId, payload.conversationId)
        .then(async () => {
          const gif = await gifProvider().resolve(payload.gifId);
          // Null covers both "no such id" and "the provider could not be
          // asked". They are one refusal here because the sender's only move
          // is the same either way: pick a different GIF.
          if (gif === null) {
            callback({ ok: false, error: "GIF_UNAVAILABLE" });
            return;
          }

          const message = await sendGifMessage({
            senderId: userId,
            conversationId: payload.conversationId,
            clientMessageId: payload.clientMessageId,
            gif,
          });
          const wire = toWireMessage(message);
          callback({ ok: true, message: wire });
          io.to(conversationRoom(message.conversationId)).emit("message:new", wire);
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          console.error("[socket] message:sendGif failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    /**
     * Accepts a sticker from a bundled pack.
     *
     * No third party is involved and nothing is uploaded: the artwork ships
     * with the application, so the only question is whether the named sticker
     * is one of them. `sendStickerMessage` answers that against the registry
     * and builds the URL from what it finds, so the ids never become a path.
     */
    socket.on("message:sendSticker", (payload, callback) => {
      sendStickerMessage({
        senderId: userId,
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        packId: payload.packId,
        stickerId: payload.stickerId,
      })
        .then((message) => {
          const wire = toWireMessage(message);
          callback({ ok: true, message: wire });
          io.to(conversationRoom(message.conversationId)).emit("message:new", wire);
        })
        .catch((error: unknown) => {
          if (error instanceof NotAParticipantError) {
            callback({ ok: false, error: "NOT_A_PARTICIPANT" });
            return;
          }
          if (error instanceof UnknownStickerError) {
            callback({ ok: false, error: "UNKNOWN_STICKER" });
            return;
          }
          console.error("[socket] message:sendSticker failed", error);
          callback({ ok: false, error: "INTERNAL" });
        });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnected ${socket.id} (${reason})`);

      // Typing is released first, and unconditionally. A typist who closes the
      // tab mid-word sends no "stopped", so this is what clears them -- and the
      // lease in the registry is what covers the case where even this does not
      // run, such as the process being killed. Neither path is load-bearing
      // alone; together the indicator cannot get stuck.
      for (const conversationId of typing.userDisconnected(userId)) {
        broadcastTyping(conversationId);
      }

      // Offline only once the User's *last* connection has gone. Closing one
      // of two tabs leaves the other holding them online, which is the whole
      // point of ref-counting rather than storing a flag.
      if (presence.disconnected(userId, socket.id)) {
        void announcePresence(userId, false);
      }
    });
  });

  return io;
}
