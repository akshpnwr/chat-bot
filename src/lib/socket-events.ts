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
 *
 * The broadcast payloads below are named types rather than inline shapes, so a
 * listener annotates its handler by importing the contract instead of
 * restating it. A restated shape is one that can drift from the wire it
 * describes -- and drift in the weakening direction (`Sequence` retyped as a
 * bare `string`) is exactly what ADR-0006 exists to prevent.
 */

/** @see ServerToClientEvents["conversation:read"] */
export interface ReadPayload {
  conversationId: string;
  userId: string;
  lastReadSeq: Sequence;
}

/** @see ServerToClientEvents["conversation:typing"] */
export interface TypingPayload {
  conversationId: string;
  /** Typists other than the recipient; a client is never told it is typing. */
  userIds: string[];
}

/** @see ServerToClientEvents["presence:changed"] */
export interface PresencePayload {
  userId: string;
  online: boolean;
}

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
  "conversation:read": (payload: ReadPayload) => void;
  /**
   * Who is typing in a Conversation right now -- the whole set, not a delta.
   *
   * A set rather than "X started" / "X stopped" because a delta stream is one
   * a client can fall out of step with: a missed "stopped" during a blip
   * leaves an indicator on screen that nothing will ever clear. Each broadcast
   * being the complete answer means the next one repairs whatever the last one
   * missed.
   */
  "conversation:typing": (payload: TypingPayload) => void;
  /**
   * A User's Presence changed. Sent only on a real transition -- their first
   * connection or their last -- so opening a second tab does not make the
   * other side's indicator flicker.
   */
  "presence:changed": (payload: PresencePayload) => void;
  /**
   * An image this User sent has been classified.
   *
   * Sent to the *sender's* own room rather than to the Conversation, because
   * it is the one outcome the recipient must never learn about. A cleared
   * image reaches the recipient as an ordinary `message:new`; a refused one
   * reaches nobody, and this is what tells its sender why -- so the spinner
   * they have been watching resolves into a reason rather than hanging.
   *
   * It carries the whole Message rather than a verdict flag: a cleared image's
   * `assetUrl` has moved out of quarantine and its status has changed, and the
   * sender's other tabs need both.
   */
  "message:moderated": (message: WireMessage) => void;
}

/**
 * Why a send was refused. A closed set rather than a bare string, so the
 * failures a client has to handle are visible in the type instead of being
 * discovered from the server's source.
 */
export type SendError =
  | "NOT_A_PARTICIPANT"
  | "PROHIBITED_LANGUAGE"
  /** The named object is not one this sender may attach -- see `message:sendImage`. */
  | "INVALID_ASSET"
  /**
   * The provider holds nothing under that id, or could not be asked. One error
   * for both, deliberately: a client can do nothing different with "no such
   * GIF" than with "the provider is down", and distinguishing them would make
   * this an oracle for which ids the provider's index contains.
   */
  | "GIF_UNAVAILABLE"
  /** No such sticker in any bundled pack -- see `message:sendSticker`. */
  | "UNKNOWN_STICKER"
  /**
   * The sender has done this too often and should wait before trying again.
   *
   * Distinct from every other refusal on this list in one way that matters to
   * the client: it is the only one that becomes acceptance simply by being
   * retried later. So it carries `retryAfterMs` and the send stays in the
   * outbox -- a refusal a client is meant to survive rather than abandon.
   */
  | "RATE_LIMITED"
  | "INTERNAL";

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

/**
 * The ack for a send: the Accepted Message, or why it was refused.
 *
 * A refusal for prohibited language carries the term that tripped it, so the
 * sender can be told what to change rather than only that something was wrong.
 * It is optional on the type rather than a separate variant because every
 * other refusal has nothing to say -- and a sender's client renders one
 * failure path either way.
 */
export type SendReply =
  | { ok: true; message: WireMessage }
  | {
      ok: false;
      error: SendError;
      term?: string;
      /**
       * How long to wait before this send could succeed, set only on
       * `RATE_LIMITED`. Present so a refused client backs off for a stated
       * interval rather than guessing -- and a guessing client retries
       * immediately, which is the behaviour the limit exists to stop.
       */
      retryAfterMs?: number;
    };

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
  /**
   * Send an image that has already been uploaded to quarantine.
   *
   * Two round trips rather than one, and the split is the design. The bytes go
   * straight from the browser to object storage under a presigned URL, so they
   * never pass through the application server; what crosses this socket is
   * only the key they landed under, plus the dimensions the browser measured.
   *
   * The ack returns as soon as the Message is Accepted at PENDING -- it is not
   * held open for classification, which costs ~50 ms on the WASM backend
   * (ADR-0007). The verdict follows separately as `message:moderated`, and the
   * recipient hears nothing at all until and unless it clears.
   *
   * `assetKey` is checked rather than trusted. It is a key this server issued,
   * under the quarantine prefix, and a client naming anything else -- an
   * object in `attachments/`, or somebody else's upload -- is refused, since
   * otherwise a caller could attach an object that never passed the check.
   */
  "message:sendImage": (
    payload: {
      conversationId: string;
      clientMessageId: string;
      /** The quarantine key returned by the upload route. */
      assetKey: string;
      /** Measured in the browser, so the bubble can reserve its space. */
      assetWidth: number;
      assetHeight: number;
    },
    callback: (reply: SendReply) => void,
  ) => void;
  /**
   * Send a GIF, named by the provider's id and never by a URL.
   *
   * The id is the whole security design of this path. A GIF skips
   * classification -- it is not content this application has looked at, and
   * ADR-0003's asynchronous path buys nothing for it -- so if the client named
   * the URL, the GIF event would be a way to put an arbitrary unmoderated image
   * into a Conversation while bypassing the check images go through. Instead
   * the server re-resolves the id against the provider and stores what the
   * provider answers, which means a GIF Message can only ever point at
   * something in the provider's index.
   *
   * One round trip, unlike an image: there is nothing to wait for, so the
   * Message is Accepted VISIBLE and broadcast before the ack returns.
   */
  "message:sendGif": (
    payload: {
      conversationId: string;
      clientMessageId: string;
      /** The provider's own id, as returned by `/api/gifs/search`. */
      gifId: string;
    },
    callback: (reply: SendReply) => void,
  ) => void;
  /**
   * Send a sticker from one of the bundled packs.
   *
   * Both ids are looked up in the registry rather than used to build a path.
   * The registry is a closed set the application ships, so an id naming
   * anything outside it is refused -- which is what stops a crafted id
   * reaching a file that is not a sticker. Like a GIF and unlike an image,
   * there is nothing unseen here, so it is Accepted VISIBLE straight away.
   */
  "message:sendSticker": (
    payload: {
      conversationId: string;
      clientMessageId: string;
      packId: string;
      stickerId: string;
    },
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
