import type { Sequence } from "./sequence";
import type { WireMessage } from "./wire";

/**
 * The socket wire contract, shared by client and server.
 *
 * Note what is absent: no event payload carries a user id. Identity is pinned
 * to the connection at handshake time (see server/socket.ts), so a client
 * cannot claim to be somebody else by shaping a payload.
 *
 * Every Sequence in these payloads is a decimal string (ADR-0006) -- the
 * server holds it as a bigint and converts once, at the boundary in
 * src/lib/wire.ts.
 */

export interface ServerToClientEvents {
  "connection:ready": (payload: { userId: string }) => void;
  /**
   * A Message accepted into a Conversation this socket has joined. Sent to the
   * whole room, sender included: the sender uses it to settle the pending
   * Message it rendered optimistically, and every other tab it has open needs
   * the Message too.
   */
  "message:new": (message: WireMessage) => void;
}

/**
 * Why a send was refused. A closed set rather than a bare string, so the
 * failures a client has to handle are visible in the type instead of being
 * discovered from the server's source.
 */
export type SendError = "NOT_A_PARTICIPANT" | "INTERNAL";

/** The reply to a sync: the Messages missed, or why the gap could not be read. */
export type SyncReply =
  | {
      ok: true;
      /** Oldest first, so the client folds them in and advances its cursor in one pass. */
      messages: WireMessage[];
      /**
       * True when the gap was wider than one page. The client syncs again from
       * the Sequence it now holds; false is what ends the drain.
       */
      hasMore: boolean;
    }
  | { ok: false; error: SendError };

/** The ack for a send: the Accepted Message, or why it was refused. */
export type SendReply =
  | { ok: true; message: WireMessage }
  | { ok: false; error: SendError };

export interface ClientToServerEvents {
  ping: (callback: (reply: { ok: true; at: number }) => void) => void;
  /**
   * Join a Conversation's broadcast room. The server runs the membership guard
   * before joining, so a non-member never enters the room at all.
   */
  "conversation:join": (
    payload: { conversationId: string },
    callback: (reply: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  /**
   * Ask for the Messages missed while away, from the Sync Cursor forward.
   *
   * `since` is the highest Sequence the client actually holds, or null when it
   * holds none -- null rather than "0" because a client claiming a Sequence it
   * does not hold is precisely how a reconnect skips Messages it never
   * received (CONTEXT.md: Sync Cursor).
   */
  "conversation:sync": (
    payload: { conversationId: string; since: Sequence | null },
    callback: (reply: SyncReply) => void,
  ) => void;
  /**
   * Send a Message. The Client Message Id is generated in the browser before
   * the Message leaves it, and is the idempotency key -- a retry after an
   * uncertain outcome yields the original Message, never a second one.
   */
  "message:send": (
    payload: { conversationId: string; clientMessageId: string; body: string },
    callback: (reply: SendReply) => void,
  ) => void;
}

export interface SocketData {
  /**
   * Established from the session cookie at handshake time and fixed for the
   * connection's lifetime. Never read from an event payload.
   */
  userId: string;
}
