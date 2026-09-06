import {
  MessageStatus,
  Prisma,
  type Conversation,
  type MessageKind,
} from "@prisma/client";
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

/** The other Participant in a one-to-one Conversation, as the list shows them. */
export interface OtherParticipant {
  id: string;
  name: string;
  image: string | null;
}

/** The most recent Message the viewer is allowed to see, previewed in the list. */
export interface LatestMessage {
  id: string;
  seq: bigint;
  body: string | null;
  kind: MessageKind;
  senderId: string;
  createdAt: Date;
}

/** One row of a User's Conversation list. */
export interface ConversationSummary {
  id: string;
  otherParticipant: OtherParticipant;
  latestMessage: LatestMessage | null;
  /** The viewer's own Read Mark, so the list can show where they left off. */
  lastReadSeq: bigint;
  /**
   * The Messages after the viewer's Read Mark -- counted on read, never stored
   * (CONTEXT.md: "Unread Count: ... Derived, never stored."). Deriving it is
   * what keeps it from drifting out of step with the Read Mark it is defined
   * against, which a maintained counter eventually would.
   */
  unreadCount: number;
}

/**
 * How many Messages sit after a Participant's Read Mark.
 *
 * Three filters, each of which the badge would be wrong without:
 *
 *  - `seq > lastReadSeq` is the definition itself (CONTEXT.md: Unread Count).
 *  - The viewer's own Messages are excluded. A Message you wrote is one you
 *    have read, and counting it would raise a badge against the sender the
 *    instant they sent something.
 *  - Visibility is filtered exactly as every other read route filters it
 *    (ADR-0003), so a Message held back by moderation cannot raise a badge
 *    pointing at something the reader will never be shown -- a badge they
 *    could never clear by reading.
 */
export async function unreadCount({
  userId,
  conversationId,
  lastReadSeq,
}: {
  userId: string;
  conversationId: string;
  lastReadSeq: bigint;
}): Promise<number> {
  return prisma.message.count({
    where: {
      conversationId,
      seq: { gt: lastReadSeq },
      senderId: { not: userId },
      status: MessageStatus.VISIBLE,
    },
  });
}

/**
 * Lists a User's Conversations, most recently active first.
 *
 * The membership filter is the query itself -- it starts from the viewer's own
 * Participant rows, so a Conversation they are not in cannot appear. There is
 * nothing to guard afterwards.
 *
 * The preview Message is filtered on visibility the same way pagination is
 * (ADR-0003): a Message blocked by moderation is not quoted in the recipient's
 * list, so the read model is the one place that decides what they can see. The
 * sender still sees their own, which is how a moderation reason reaches them.
 */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const memberships = await prisma.participant.findMany({
    where: { userId },
    select: {
      lastReadSeq: true,
      conversation: {
        select: {
          id: true,
          participants: {
            where: { userId: { not: userId } },
            select: { user: { select: { id: true, name: true, image: true } } },
          },
          messages: {
            where: { OR: [{ status: MessageStatus.VISIBLE }, { senderId: userId }] },
            orderBy: { seq: "desc" },
            take: 1,
            select: {
              id: true,
              seq: true,
              body: true,
              kind: true,
              senderId: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  // Counted per Conversation rather than in the query above, and issued
  // together rather than one after another.
  //
  // Each count compares against that row's own Read Mark, which is a different
  // value per row -- a correlated subquery Prisma's relation counts cannot
  // express, since they take one filter for every row. Raw SQL could, and is
  // the thing to reach for if this ever gets slow; it is not worth the cost
  // here, because a one-to-one system gives a User as many Conversations as
  // they have correspondents, and these run concurrently rather than serially.
  const counted = await Promise.all(
    memberships.map(async (membership) => ({
      membership,
      unread: await unreadCount({
        userId,
        conversationId: membership.conversation.id,
        lastReadSeq: membership.lastReadSeq,
      }),
    })),
  );

  const summaries: ConversationSummary[] = [];
  for (const { membership, unread } of counted) {
    const other = membership.conversation.participants[0]?.user;
    // A Conversation is a pair by definition; one missing its other side is a
    // half-built row that nobody can open, so it is left out rather than
    // rendered as a Conversation with nobody in it.
    if (!other) continue;

    summaries.push({
      id: membership.conversation.id,
      otherParticipant: { id: other.id, name: other.name, image: other.image },
      latestMessage: membership.conversation.messages[0] ?? null,
      lastReadSeq: membership.lastReadSeq,
      unreadCount: unread,
    });
  }

  // Ordered here rather than in SQL: "most recently active" is the latest
  // Message's Sequence, which is a per-row subquery result Prisma cannot sort
  // on. A User's Conversation count is small enough that this is cheap.
  //
  // A Conversation with no Messages has no Sequence at all, rather than a low
  // one -- a Sequence exists only once the server Accepts a Message. It sorts
  // last by that absence, without inventing a number that was never assigned.
  return summaries.sort((a, b) => {
    const aSeq = a.latestMessage?.seq;
    const bSeq = b.latestMessage?.seq;
    if (aSeq === undefined && bSeq === undefined) return 0;
    if (aSeq === undefined) return 1;
    if (bSeq === undefined) return -1;
    if (aSeq === bSeq) return 0;
    return bSeq > aSeq ? 1 : -1;
  });
}
