import { MessageStatus, Prisma, type Message } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertParticipant } from "@/server/authorization";
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
