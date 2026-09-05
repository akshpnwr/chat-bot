import { Prisma, type Conversation } from "@prisma/client";
import { prisma } from "@/lib/db";

/** Postgres' unique-violation code, raised by the pair-key constraint. */
const UNIQUE_VIOLATION = "P2002";

/**
 * The key identifying a pair of Users. Sorting the two ids means a pair yields
 * the same key whichever side opens the thread, so the two directions collide
 * on the unique constraint instead of producing two Conversations.
 */
export function conversationPairKey(userId: string, otherUserId: string): string {
  return [userId, otherUserId].sort().join(":");
}

/** Raised when a User tries to open a Conversation with themselves. */
export class SelfConversationError extends Error {
  readonly code = "SELF_CONVERSATION";

  constructor(userId: string) {
    super(`User ${userId} cannot open a Conversation with themselves`);
    this.name = "SelfConversationError";
  }
}

/**
 * Opens the Conversation between two Users, creating it only if none exists.
 * There is never more than one Conversation for a given pair, so reopening a
 * thread returns the original rather than starting a second one alongside it.
 *
 * The pair invariant is arbitrated by the database rather than by a
 * read-then-write check that two concurrent opens could both pass: the insert
 * is attempted, and a unique violation is resolved by returning the
 * Conversation the winner created.
 */
export async function openConversation({
  userId,
  otherUserId,
}: {
  userId: string;
  otherUserId: string;
}): Promise<Conversation> {
  if (userId === otherUserId) {
    throw new SelfConversationError(userId);
  }

  const pairKey = conversationPairKey(userId, otherUserId);

  const existing = await prisma.conversation.findUnique({ where: { pairKey } });
  if (existing) return existing;

  try {
    return await prisma.conversation.create({
      data: {
        pairKey,
        participants: { create: [{ userId }, { userId: otherUserId }] },
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === UNIQUE_VIOLATION
    ) {
      const won = await prisma.conversation.findUnique({ where: { pairKey } });
      if (won) return won;
    }
    throw error;
  }
}
