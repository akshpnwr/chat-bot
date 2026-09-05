import type { Participant } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Raised when a user touches a Conversation they are not a Participant of.
 * Callers map this to a 403 or a socket error; it is deliberately identical
 * whether the Conversation does not exist or the user simply is not a member,
 * so the guard does not leak which Conversations exist.
 */
export class NotAParticipantError extends Error {
  readonly code = "NOT_A_PARTICIPANT";

  constructor(userId: string, conversationId: string) {
    super(`User ${userId} is not a Participant of Conversation ${conversationId}`);
    this.name = "NotAParticipantError";
  }
}

/**
 * The single membership guard. Every entry point that touches
 * conversation-scoped data calls this first -- REST pagination, socket send,
 * reconnect sync and upload presign -- and a socket joins a Conversation's
 * broadcast room only after it passes, so the broadcast primitive itself
 * cannot deliver to a non-member.
 *
 * Returns the Participant row, so callers get the Read Mark without a second
 * query.
 */
export async function assertParticipant(
  userId: string,
  conversationId: string,
): Promise<Participant> {
  const participant = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
  });

  if (!participant) {
    throw new NotAParticipantError(userId, conversationId);
  }

  return participant;
}
