import { MessageStatus, Prisma, type Message } from "@prisma/client";
import { prisma } from "@/lib/db";
import { assertParticipant } from "@/server/authorization";

/** Postgres' unique-violation code, raised by the idempotency constraint. */
const UNIQUE_VIOLATION = "P2002";

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
