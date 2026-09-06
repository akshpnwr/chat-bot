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
  /**
   * A Participant's Read Mark has moved. Sent to the Conversation's room, so
   * the sender learns their Message was read and the reader's own other tabs
   * clear the same badge.
   *
   * It carries whose mark moved because a room holds both Participants, and a
   * reader must not settle their own unread count against the other side's
   * mark. That is the one user id in these payloads the server puts there
   * itself -- never one a client claimed.
   */
  "conversation:read": (payload: {
    conversationId: string;
    userId: string;
    lastReadSeq: Sequence;
  }) => void;
  /**
   * Who is typing in a Conversation right now -- the whole set, not a delta.
   *
   * A set rather than "X started" / "X stopped" because a delta stream is one
   * a client can fall out of step with: a missed "stopped" during a blip
   * leaves an indicator on screen that nothing will ever clear. Each broadcast
   * being the complete answer means the next one repairs whatever the last one
   * missed.
   */
  "conversation:typing": (payload: {
    conversationId: string;
    /** Typists other than the recipient; a client is never told it is typing. */
    userIds: string[];
  }) => void;
  /**
   * A User's Presence changed. Sent only on a real transition -- their first
   * connection or their last -- so opening a second tab does not make the
   * other side's indicator flicker.
   */
  "presence:changed": (payload: { userId: string; online: boolean }) => void;
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

/**
 * The reply to a join: the Conversation's live state as it stands right now.
 *
 * Presence and typing exist only in process memory (ADR-0001) and are
 * broadcast on transition, so this snapshot is the only way a client that
 * arrives between transitions learns the current answer.
 */
export type JoinReply =
  | {
      ok: true;
      /** Whether the other Participant currently holds any live connection. */
      otherOnline: boolean;
      /** Who is typing right now, the joining client itself excluded. */
      typing: string[];
      /** The other Participant's Read Mark, so a sender sees what was read. */
      otherLastReadSeq: Sequence;
    }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  ping: (callback: (reply: { ok: true; at: number }) => void) => void;
  /**
   * Join a Conversation's broadcast room. The server runs the membership guard
   * before joining, so a non-member never enters the room at all.
   *
   * The reply carries the Conversation's current live state rather than only
   * an acknowledgement. Presence and typing are broadcast on transition, and a
   * client that joined after the last transition would otherwise have to wait
   * for the next one -- showing the other Participant as offline until they
   * happen to reconnect. Answering with the state as it stands is what makes
   * a reconnecting client's view correct immediately.
   */
  "conversation:join": (
    payload: { conversationId: string },
    callback: (reply: JoinReply) => void,
  ) => void;
  /**
   * Advance the sender's Read Mark to a Sequence they have read up to.
   *
   * The mark can only move forward, and that is enforced by the server rather
   * than trusted from here (see `advanceReadMark`) -- two tabs advancing at
   * once would otherwise walk it backwards.
   */
  "conversation:read": (
    payload: { conversationId: string; upTo: Sequence },
    callback: (reply: { ok: true; lastReadSeq: Sequence } | { ok: false; error: SendError }) => void,
  ) => void;
  /**
   * Announce that the sender is typing, or has stopped.
   *
   * Throttled by the client rather than emitted per keystroke, and renewed
   * while composing continues: the server holds it as a lease that lapses on
   * its own, so a typist who vanishes mid-word needs no event to clear them.
   *
   * Deliberately without an acknowledgement. A typing announcement that did
   * not arrive is corrected by the next one a second or two later, and by the
   * lease lapsing if there is no next one -- so there is nothing a callback
   * could usefully do, and every keystroke burst would pay for a round trip.
   */
  "conversation:typing": (payload: {
    conversationId: string;
    typing: boolean;
  }) => void;
  /**
   * Ask which of these Users are online right now.
   *
   * Presence is announced on transition, so a client that connects while
   * somebody is already online never hears about them. This is the snapshot
   * that fills that gap -- asked for on connect and on every reconnect, since
   * a reconnection returns to a server that may have changed its mind about
   * everybody while the client was away.
   *
   * Answering is not a disclosure: Presence for these Users is already
   * broadcast to every connected client, so this reports what the client would
   * learn by waiting.
   */
  "presence:snapshot": (
    payload: { userIds: string[] },
    callback: (reply: { ok: true; online: string[] }) => void,
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
