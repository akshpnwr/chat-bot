import type { Message, MessageKind, MessageStatus } from "@prisma/client";
import type { ConversationSummary } from "@/server/conversations";
import type { Sequence } from "./sequence";

/**
 * The shapes that cross the wire, and the only place a domain row is turned
 * into one.
 *
 * The single job here is ADR-0006: a Sequence is a `bigint` on the server and a
 * decimal string everywhere outside it. Routing every payload through these
 * functions is what keeps that conversion in one place -- a row handed
 * straight to `JSON.stringify` throws on its bigint, which is the failure
 * making the omission loud rather than silent.
 */

/** A Message as the client holds it. */
export interface WireMessage {
  id: string;
  seq: Sequence;
  conversationId: string;
  senderId: string;
  kind: MessageKind;
  status: MessageStatus;
  body: string | null;
  assetUrl: string | null;
  /** Intrinsic dimensions, so the list reserves an asset's space before it loads. */
  assetWidth: number | null;
  assetHeight: number | null;
  /**
   * Echoed back so the sender can settle the pending Message it rendered
   * optimistically against the accepted one, rather than showing both.
   */
  clientMessageId: string;
  moderationReason: string | null;
  createdAt: string;
}

export function toWireMessage(message: Message): WireMessage {
  return {
    id: message.id,
    seq: message.seq.toString(),
    conversationId: message.conversationId,
    senderId: message.senderId,
    kind: message.kind,
    status: message.status,
    body: message.body,
    assetUrl: message.assetUrl,
    assetWidth: message.assetWidth,
    assetHeight: message.assetHeight,
    clientMessageId: message.clientMessageId,
    moderationReason: message.moderationReason,
    createdAt: message.createdAt.toISOString(),
  };
}

/** The latest Message as previewed in the Conversation list. */
export interface WireLatestMessage {
  id: string;
  seq: Sequence;
  body: string | null;
  kind: MessageKind;
  senderId: string;
  createdAt: string;
}

/** One row of the Conversation list as the client holds it. */
export interface WireConversation {
  id: string;
  otherParticipant: { id: string; name: string; image: string | null };
  latestMessage: WireLatestMessage | null;
  /** The viewer's Read Mark -- a reading of a Sequence, so likewise a string. */
  lastReadSeq: Sequence;
  /**
   * The Unread Count. A number rather than a string, unlike the Sequences
   * above: it counts Messages rather than naming one, so it is bounded by how
   * many exist rather than by BIGSERIAL, and ADR-0006 does not apply to it.
   */
  unreadCount: number;
}

export function toWireConversation(summary: ConversationSummary): WireConversation {
  const latest = summary.latestMessage;
  return {
    id: summary.id,
    otherParticipant: summary.otherParticipant,
    latestMessage:
      latest === null
        ? null
        : {
            id: latest.id,
            seq: latest.seq.toString(),
            body: latest.body,
            kind: latest.kind,
            senderId: latest.senderId,
            createdAt: latest.createdAt.toISOString(),
          },
    lastReadSeq: summary.lastReadSeq.toString(),
    unreadCount: summary.unreadCount,
  };
}

/** A page of history as it crosses the wire, newest Message first. */
export interface WireMessagePage {
  messages: WireMessage[];
  /** The cursor to request the next page backwards, or null at the start. */
  nextCursor: Sequence | null;
}
