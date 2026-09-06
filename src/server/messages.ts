import { MessageKind, MessageStatus, Prisma, type Message } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertParticipant, NotAParticipantError } from "@/server/authorization";
import { screen } from "@/server/moderation/profanity";

/** Postgres' unique-violation code, raised by the idempotency constraint. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Raised when a Message is refused for prohibited language.
 *
 * It carries the term that tripped the check, because the ticket asks that the
 * sender be told which word refused it rather than given a bare refusal --
 * a sender who cannot tell what was wrong can only guess at a rewrite.
 *
 * Naming the term is a deliberate disclosure to the *sender* only. It is the
 * word they themselves just typed, so it tells them nothing they did not
 * already write; the recipient never learns the Message existed.
 */
export class ProhibitedLanguageError extends Error {
  readonly code = "PROHIBITED_LANGUAGE";

  constructor(readonly term: string) {
    super(`Message contains a prohibited term: ${term}`);
    this.name = "ProhibitedLanguageError";
  }
}

/**
 * Sends a Message into a Conversation and returns it once Accepted.
 *
 * Idempotency is arbitrated by the database, not by a read-then-write check
 * that two concurrent sends could both pass. The insert is attempted
 * unconditionally; the unique constraint on (conversationId, clientMessageId)
 * rejects the loser, and that rejection is resolved by returning the Message
 * the winner stored. A retry therefore yields the original Message rather than
 * a second one, and the original's body is preserved -- a Message is immutable
 * once accepted.
 *
 * The membership guard runs first, so a user who is not a Participant is
 * refused before anything is written.
 *
 * Moderation runs second, before the insert, and that placement is the whole
 * of the enforcement story. This module is the only way a Message is created,
 * so screening here holds however the send arrived -- over the socket, or from
 * somebody calling the API directly with their own client. A check anywhere
 * further out would be a check somebody could go around.
 *
 * A Refused Message is not stored at all, rather than stored and hidden. The masking
 * alternative was rejected by the ticket outright: the sender is told which
 * term tripped the check and gets their words back to edit, rather than having
 * them silently altered.
 *
 * This goes further than ADR-0003, which gates moderation in the read model by
 * writing a REJECTED row that recipient-facing queries filter out. No text
 * Message ever reaches that state: screening is synchronous, so there is no
 * window in which a row is needed to hold a decision that has already been
 * made, and a Message that was never written cannot be leaked by a query
 * somebody adds later. ADR-0003's read-model filter still stands and is still
 * load-bearing -- it is what will hold images back while they are classified,
 * which is the asynchronous case it was written for.
 */
export async function sendMessage({
  senderId,
  conversationId,
  clientMessageId,
  body,
}: {
  senderId: string;
  conversationId: string;
  clientMessageId: string;
  body: string;
}): Promise<Message> {
  await assertParticipant(senderId, conversationId);

  const screening = screen(body);
  if (screening.refused) {
    throw new ProhibitedLanguageError(screening.term);
  }

  try {
    return await prisma.message.create({
      data: { senderId, conversationId, clientMessageId, body },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      const existing = await prisma.message.findUnique({
        where: { conversationId_clientMessageId: { conversationId, clientMessageId } },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

/** A page of history, newest first, with the cursor to continue backwards. */
export interface MessagePage {
  messages: Message[];
  /**
   * The seq to pass as `before` for the next page, or null when the caller has
   * reached the start of the Conversation.
   */
  nextCursor: bigint | null;
}

/**
 * Reads a page of a Conversation's history, most recent Message first.
 *
 * Paging walks the monotonic seq (ADR-0002) rather than a timestamp, so a page
 * boundary cannot land on a tie and silently drop or duplicate a Message.
 *
 * The membership guard runs first, so history never leaves the module for a
 * user who is not a Participant.
 *
 * Visibility is filtered here in the read model rather than only in the
 * broadcast path (ADR-0003), so a Message that failed moderation cannot be
 * retrieved by any route, pagination included. The sender still sees their own
 * PENDING and REJECTED Messages -- that is how a spinner and a moderation
 * reason reach them -- while the recipient never learns a blocked Message
 * existed.
 */
export async function readMessages({
  userId,
  conversationId,
  limit,
  before,
}: {
  userId: string;
  conversationId: string;
  limit: number;
  before?: bigint;
}): Promise<MessagePage> {
  await assertParticipant(userId, conversationId);

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      ...(before === undefined ? {} : { seq: { lt: before } }),
      OR: [{ status: MessageStatus.VISIBLE }, { senderId: userId }],
    },
    orderBy: { seq: "desc" },
    take: limit,
  });

  const oldest = messages.at(-1);
  return {
    messages,
    // A short page means there is nothing older left to fetch.
    nextCursor: messages.length === limit && oldest ? oldest.seq : null,
  };
}

/**
 * How many Messages one sync round trip carries.
 *
 * Bounded rather than unbounded because a client returning after a long
 * absence could otherwise ask the server to load and serialize an entire
 * Conversation into one frame. The bound is what makes recovery incremental:
 * `hasMore` tells the caller to come back with the cursor advanced, so an
 * arbitrarily long gap is drained in fixed-size steps instead of one that
 * grows with how long the client was away.
 */
export const SYNC_PAGE_LIMIT = 200;

/** A gap-fill: the Messages a client missed, and whether more remain. */
export interface MessageGap {
  /** Oldest first -- the order the client folds them in and advances its cursor by. */
  messages: Message[];
  /**
   * True when the gap was wider than one page. The caller syncs again from the
   * Sequence of the last Message here; false is what makes a drain terminate.
   */
  hasMore: boolean;
}

/**
 * Reads the Messages a client missed while it was away, oldest first.
 *
 * This is the real guarantee behind reconnection. The transport's own
 * short-gap recovery is a fast path that expires -- it holds a buffer for a
 * couple of minutes and gives up -- so it cannot be what the promise "nothing
 * is lost" rests on. This can, because it asks the database rather than a
 * buffer: the client reports the highest Sequence it holds and receives
 * precisely what lies above it, whether that gap is two seconds or two days
 * wide.
 *
 * `after` is exclusive, which is what makes the sync exactly-once at the seam.
 * The client's cursor names a Message it already holds; returning that Message
 * again would deliver a duplicate on every reconnect. A client holding nothing
 * passes 0, below every assigned Sequence (ADR-0002), so the same query serves
 * a first sync and a resumed one rather than needing a special case.
 *
 * Ascending order is not cosmetic either: the client advances its cursor to the
 * last Message it folded in, so a page delivered out of order would leave the
 * cursor naming a Message with unrecovered Messages beneath it -- a gap that
 * would never be asked for again.
 *
 * The membership guard runs first, and visibility is filtered exactly as in
 * `readMessages` (ADR-0003) -- reconnect is another read route, not a way
 * around the read model.
 */
export async function syncMessages({
  userId,
  conversationId,
  after,
}: {
  userId: string;
  conversationId: string;
  after: bigint;
}): Promise<MessageGap> {
  await assertParticipant(userId, conversationId);

  // One more than the page, so "is there another page" is answered by the same
  // query rather than by a second count that could disagree with it.
  const found = await prisma.message.findMany({
    where: {
      conversationId,
      seq: { gt: after },
      OR: [{ status: MessageStatus.VISIBLE }, { senderId: userId }],
    },
    orderBy: { seq: "asc" },
    take: SYNC_PAGE_LIMIT + 1,
  });

  const hasMore = found.length > SYNC_PAGE_LIMIT;
  return {
    messages: hasMore ? found.slice(0, SYNC_PAGE_LIMIT) : found,
    hasMore,
  };
}

/**
 * Accepts an image into a Conversation as PENDING, before it has been classified.
 *
 * This is the asynchronous path ADR-0003 was written for, and the reason text
 * and images diverge here. Profanity screening is a sub-millisecond pure
 * function, so a text Message can be ruled on inside the send and written
 * VISIBLE or not written at all. Classification is not: it costs around 50 ms
 * on the WASM backend (ADR-0007), which is too long to hold a send's
 * acknowledgement open. So the Message is Accepted first -- durably stored,
 * with its Sequence assigned -- and ruled on afterwards.
 *
 * Accepting before classifying is safe precisely because visibility is a
 * property of the read model rather than of the broadcast. A PENDING Message
 * is filtered out of every recipient-facing query by `readMessages` and
 * `syncMessages`, so the window between acceptance and the verdict is not a
 * window in which the recipient can reach the image by paging, syncing, or
 * anything else. The sender sees it, which is what their spinner is drawn from.
 *
 * The asset is recorded by its quarantine key rather than a URL. Until the
 * verdict lands there is no URL worth handing out, and storing one would mean
 * the row briefly names a readable location for an image nobody has looked at.
 *
 * Membership and idempotency work exactly as they do for text -- the same
 * guard, the same constraint, resolved the same way -- because a retried image
 * send is the same send, and must not become a second Message with a second
 * upload behind it.
 */
export async function sendImageMessage({
  senderId,
  conversationId,
  clientMessageId,
  assetKey,
  assetWidth,
  assetHeight,
}: {
  senderId: string;
  conversationId: string;
  clientMessageId: string;
  /** The object's key in quarantine; it becomes a URL only once promoted. */
  assetKey: string;
  /**
   * The image's intrinsic dimensions, measured by the sender's browser before
   * the upload. Stored so the list can reserve the bubble's space before the
   * image loads, which is what keeps the thread from reflowing around it.
   */
  assetWidth: number;
  assetHeight: number;
}): Promise<Message> {
  await assertParticipant(senderId, conversationId);

  try {
    return await prisma.message.create({
      data: {
        senderId,
        conversationId,
        clientMessageId,
        kind: MessageKind.IMAGE,
        status: MessageStatus.PENDING,
        assetUrl: assetKey,
        assetWidth,
        assetHeight,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      const existing = await prisma.message.findUnique({
        where: { conversationId_clientMessageId: { conversationId, clientMessageId } },
      });
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Clears a classified image for delivery.
 *
 * The transition and the promoted key are written together, in one update, so
 * there is no instant at which a Message is VISIBLE while still pointing into
 * quarantine -- which is the one ordering that would have the recipient
 * fetching an object that is about to be moved out from under them.
 *
 * Only a PENDING Message is transitioned. The `status` in the WHERE clause is
 * what makes this safe to run twice: a Message already ruled on -- cleared by
 * a duplicate worker, or REJECTED -- matches nothing and is left exactly as it
 * is, rather than a rejection being quietly overwritten into a delivery.
 */
export async function visibleImageMessage({
  messageId,
  assetUrl,
}: {
  messageId: string;
  assetUrl: string;
}): Promise<Message> {
  const updated = await prisma.message.updateManyAndReturn({
    where: { id: messageId, status: MessageStatus.PENDING },
    data: { status: MessageStatus.VISIBLE, assetUrl },
  });

  const message = updated[0];
  if (message) return message;

  // Nothing matched, so it had already been ruled on. Returning the row as it
  // stands lets the caller see the decision that won rather than throwing at
  // it -- a second verdict arriving late is a race, not a failure.
  const existing = await prisma.message.findUnique({ where: { id: messageId } });
  if (!existing) throw new Error(`No such Message: ${messageId}`);
  return existing;
}

/**
 * Records that a classified image failed moderation.
 *
 * The row is kept rather than deleted, at REJECTED, and that is the whole
 * mechanism by which the recipient never learns it existed: every
 * recipient-facing query filters on VISIBLE (ADR-0003), so the Message is
 * unreachable by history, pagination and reconnect sync alike -- not merely
 * absent from a broadcast that was never sent.
 *
 * Keeping it is also what the sender needs. They saw the image go, and a row
 * that vanished would leave them with an image that silently disappeared
 * rather than one that says why it was refused. The reason is stored on the
 * Message for exactly that.
 *
 * The `assetUrl` is cleared as it is rejected. The object itself is deleted by
 * the caller, and leaving the row naming a key that no longer exists -- or
 * worse, one that still does -- would be a pointer to content the system has
 * just decided must not be delivered.
 *
 * Guarded on PENDING for the same reason as the clearance above, so a late
 * duplicate cannot flip an already-decided Message.
 */
export async function rejectImageMessage({
  messageId,
  reason,
}: {
  messageId: string;
  reason: string;
}): Promise<Message> {
  const updated = await prisma.message.updateManyAndReturn({
    where: { id: messageId, status: MessageStatus.PENDING },
    data: {
      status: MessageStatus.REJECTED,
      moderationReason: reason,
      assetUrl: null,
    },
  });

  const message = updated[0];
  if (message) return message;

  const existing = await prisma.message.findUnique({ where: { id: messageId } });
  if (!existing) throw new Error(`No such Message: ${messageId}`);
  return existing;
}

/**
 * The storage key a User is allowed to read for one image Message.
 *
 * This exists because a presigned GET is a real capability against the bucket,
 * and handing one out is a read of the Conversation just as much as loading a
 * page of history is. Deciding it here rather than in the route means the
 * asset path is governed by the same rule as every other read route
 * (ADR-0003), rather than by a second rule written beside it that could drift.
 *
 * The rule is `readMessages`' rule narrowed to a single Message: VISIBLE to
 * anybody in the Conversation, and the sender's own Messages at any status --
 * which is what lets a sender see the image they just sent while it is still
 * being classified. A REJECTED Message satisfies neither for the recipient,
 * and for the sender it has had its key cleared, so there is nothing to give
 * out in either case.
 *
 * Every refusal is the same `NotAParticipantError`, whatever the actual cause:
 * a Message that does not exist, one in somebody else's Conversation, and one
 * that failed moderation are indistinguishable from outside. Distinguishing
 * them would turn this route into an oracle for which Message ids exist and
 * which images were refused.
 */
export async function readableAsset({
  userId,
  messageId,
}: {
  userId: string;
  messageId: string;
}): Promise<string> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.assetUrl === null) {
    throw new NotAParticipantError(userId, "unknown");
  }

  // Membership first, so a stranger learns nothing about the Message beyond
  // the refusal they would have received anyway.
  await assertParticipant(userId, message.conversationId);

  const readable =
    message.status === MessageStatus.VISIBLE || message.senderId === userId;
  if (!readable) {
    throw new NotAParticipantError(userId, message.conversationId);
  }

  return message.assetUrl;
}
