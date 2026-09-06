import { prisma } from "@/lib/db";
import { assertParticipant } from "@/server/authorization";

/**
 * The Read Mark: a Participant's high-water mark through a Conversation.
 *
 * One rule governs everything here -- a Read Mark only ever moves forward
 * (CONTEXT.md: Read Mark). That is not a convention the callers observe, it is
 * enforced in the write itself, because the callers cannot be trusted to.
 * Opening a Conversation in two tabs has both of them advancing the same mark
 * against whatever each happened to have on screen, and a reader who scrolls
 * up is looking at Sequences below the one they have already reached. Both
 * would walk the mark backwards if the write took whatever it was given.
 */

/**
 * Advances a Participant's Read Mark to `upTo`, and returns where the mark
 * actually stands afterwards.
 *
 * The monotonic guarantee is arbitrated by the database rather than by a
 * read-then-write check, for the same reason idempotency is (see
 * `sendMessage`): two tabs advancing at once would both read the old mark,
 * both decide their own value is higher, and the later write would win
 * regardless of which was actually further along. A conditional UPDATE has the
 * comparison and the write happen as one operation, so the lower of two
 * concurrent advances matches nothing and changes nothing.
 *
 * The return value is the mark as it now stands, not the value passed in --
 * those differ precisely when a backwards advance was rejected, and the caller
 * broadcasting a read receipt must send what is true rather than what it asked
 * for.
 *
 * The membership guard runs first, so a user who is not a Participant cannot
 * write a mark into a Conversation they are not in.
 */
export async function advanceReadMark({
  userId,
  conversationId,
  upTo,
}: {
  userId: string;
  conversationId: string;
  upTo: bigint;
}): Promise<bigint> {
  const participant = await assertParticipant(userId, conversationId);

  // Nothing to do, and nothing to race: the mark is already at or beyond this.
  if (participant.lastReadSeq >= upTo) return participant.lastReadSeq;

  const advanced = await prisma.participant.updateMany({
    where: {
      userId,
      conversationId,
      // The whole guarantee, in one clause. A concurrent advance that got there
      // first leaves this matching zero rows rather than overwriting it.
      lastReadSeq: { lt: upTo },
    },
    data: { lastReadSeq: upTo },
  });

  // Matched nothing, so somebody else advanced past `upTo` in between. Their
  // mark is the true one; re-read it rather than reporting the value this call
  // wanted to write.
  if (advanced.count === 0) return readMarkOf(userId, conversationId);

  return upTo;
}

/**
 * Where a Participant's Read Mark stands, or 0 when they have read nothing.
 *
 * 0 rather than null: it is below every assigned Sequence (ADR-0002), so
 * "everything after the mark" is the whole Conversation without the callers
 * needing a special case for a reader who has just arrived.
 */
export async function readMarkOf(
  userId: string,
  conversationId: string,
): Promise<bigint> {
  const participant = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: { lastReadSeq: true },
  });

  return participant?.lastReadSeq ?? 0n;
}

/** The other side of a one-to-one Conversation, as the live layer needs them. */
export interface OtherSide {
  userId: string;
  /** Their Read Mark, so a sender can see how far the recipient has read. */
  lastReadSeq: bigint;
}

/**
 * The other Participant of a Conversation, or null when the asker is not in it.
 *
 * Null rather than a thrown NotAParticipantError, because the callers are the
 * live layer -- a join reply assembling presence, typing and read state -- and
 * for them "not a member" is one of several answers to compose rather than an
 * exception to translate. It is deliberately the same null a Conversation that
 * does not exist produces, so the answer does not leak which Conversations
 * there are (the same reason `assertParticipant` does not distinguish them).
 */
export async function otherParticipantOf(
  userId: string,
  conversationId: string,
): Promise<OtherSide | null> {
  // Started from the asker's own membership rather than from the Conversation,
  // so a non-member gets null from the query itself rather than from a check
  // afterwards that somebody could later forget to make.
  const membership = await prisma.participant.findUnique({
    where: { userId_conversationId: { userId, conversationId } },
    select: {
      conversation: {
        select: {
          participants: {
            where: { userId: { not: userId } },
            select: { userId: true, lastReadSeq: true },
          },
        },
      },
    },
  });

  const other = membership?.conversation.participants[0];
  if (!other) return null;

  return { userId: other.userId, lastReadSeq: other.lastReadSeq };
}

/**
 * The Users a viewer shares a Conversation with.
 *
 * This is the audience for a viewer's Presence. Presence is broadcast on
 * transition, and broadcasting it to every connected client would tell
 * strangers when somebody signs in -- a disclosure nobody asked for, and one
 * that grows with the user base rather than with the viewer's Conversations.
 * Scoping it to correspondents means a User's Presence reaches exactly the
 * people who can already see them in a Conversation list.
 */
export async function correspondentsOf(userId: string): Promise<string[]> {
  // Started from the viewer's own memberships, so the result cannot include
  // somebody they share nothing with.
  const memberships = await prisma.participant.findMany({
    where: { userId },
    select: {
      conversation: {
        select: {
          participants: {
            where: { userId: { not: userId } },
            select: { userId: true },
          },
        },
      },
    },
  });

  // Deduplicated: a pair has one Conversation, but that is a rule the database
  // enforces rather than something this function needs to assume.
  const correspondents = new Set<string>();
  for (const membership of memberships) {
    for (const other of membership.conversation.participants) {
      correspondents.add(other.userId);
    }
  }
  return [...correspondents];
}
