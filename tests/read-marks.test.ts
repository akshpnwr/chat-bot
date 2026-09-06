import { beforeEach, describe, expect, it } from "vitest";
import { MessageStatus } from "@prisma/client";
import { createUser, resetDatabase } from "./setup/database";
import { NotAParticipantError } from "@/server/authorization";
import { listConversations, openConversation } from "@/server/conversations";
import { sendMessage } from "@/server/messages";
import {
  advanceReadMark,
  correspondentsOf,
  otherParticipantOf,
  readMarkOf,
} from "@/server/read-marks";
import { prisma } from "@/lib/db";

let ada: Awaited<ReturnType<typeof createUser>>;
let grace: Awaited<ReturnType<typeof createUser>>;
let mallory: Awaited<ReturnType<typeof createUser>>;
let conversationId: string;

beforeEach(async () => {
  await resetDatabase();
  ada = await createUser("Ada");
  grace = await createUser("Grace");
  mallory = await createUser("Mallory");
  const conversation = await openConversation({
    userId: ada.id,
    otherUserId: grace.id,
  });
  conversationId = conversation.id;
});

/** Sends `count` Messages from Grace and returns them in send order. */
async function graceSends(count: number, prefix = "m") {
  const sent = [];
  for (let index = 0; index < count; index += 1) {
    sent.push(
      await sendMessage({
        senderId: grace.id,
        conversationId,
        clientMessageId: `${prefix}-${index}`,
        body: `${prefix}-${index}`,
      }),
    );
  }
  return sent;
}

describe("advanceReadMark", () => {
  it("moves the Read Mark to the Sequence the reader has reached", async () => {
    const sent = await graceSends(3);

    const mark = await advanceReadMark({
      userId: ada.id,
      conversationId,
      upTo: sent[2]!.seq,
    });

    expect(mark).toBe(sent[2]!.seq);
    expect(await readMarkOf(ada.id, conversationId)).toBe(sent[2]!.seq);
  });

  it("never moves the Read Mark backwards", async () => {
    const sent = await graceSends(3);
    await advanceReadMark({ userId: ada.id, conversationId, upTo: sent[2]!.seq });

    const mark = await advanceReadMark({
      userId: ada.id,
      conversationId,
      upTo: sent[0]!.seq,
    });

    // The earlier Sequence is ignored rather than written: a reader who scrolls
    // back has not unread what they already read.
    expect(mark).toBe(sent[2]!.seq);
    expect(await readMarkOf(ada.id, conversationId)).toBe(sent[2]!.seq);
  });

  it("is idempotent -- advancing to the mark already held changes nothing", async () => {
    const sent = await graceSends(2);
    await advanceReadMark({ userId: ada.id, conversationId, upTo: sent[1]!.seq });

    const mark = await advanceReadMark({
      userId: ada.id,
      conversationId,
      upTo: sent[1]!.seq,
    });

    expect(mark).toBe(sent[1]!.seq);
  });

  it("moves only the reader's own Read Mark, never the other Participant's", async () => {
    const sent = await graceSends(2);

    await advanceReadMark({ userId: ada.id, conversationId, upTo: sent[1]!.seq });

    expect(await readMarkOf(grace.id, conversationId)).toBe(0n);
  });

  it("refuses a user who is not a Participant", async () => {
    const sent = await graceSends(1);

    await expect(
      advanceReadMark({ userId: mallory.id, conversationId, upTo: sent[0]!.seq }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });

  it("holds concurrent advances at the highest Sequence", async () => {
    const sent = await graceSends(4);

    // The monotonic guarantee has to survive two tabs advancing at once, which
    // is why it is a conditional write rather than a read-then-write.
    await Promise.all([
      advanceReadMark({ userId: ada.id, conversationId, upTo: sent[3]!.seq }),
      advanceReadMark({ userId: ada.id, conversationId, upTo: sent[1]!.seq }),
      advanceReadMark({ userId: ada.id, conversationId, upTo: sent[0]!.seq }),
    ]);

    expect(await readMarkOf(ada.id, conversationId)).toBe(sent[3]!.seq);
  });
});

describe("unread counting", () => {
  it("counts the Messages after the reader's Read Mark", async () => {
    const sent = await graceSends(5);
    await advanceReadMark({ userId: ada.id, conversationId, upTo: sent[1]!.seq });

    const summaries = await listConversations(ada.id);

    expect(summaries[0]?.unreadCount).toBe(3);
  });

  it("counts everything when the reader has read nothing", async () => {
    await graceSends(4);

    const summaries = await listConversations(ada.id);

    expect(summaries[0]?.unreadCount).toBe(4);
  });

  it("counts nothing once the reader has caught up", async () => {
    const sent = await graceSends(3);
    await advanceReadMark({ userId: ada.id, conversationId, upTo: sent[2]!.seq });

    const summaries = await listConversations(ada.id);

    expect(summaries[0]?.unreadCount).toBe(0);
  });

  it("does not count the reader's own Messages as unread", async () => {
    // A Message you sent is one you have read by definition; counting it would
    // make the badge appear the moment somebody sends, against themselves.
    await sendMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId: "own-1",
      body: "mine",
    });

    const summaries = await listConversations(ada.id);

    expect(summaries[0]?.unreadCount).toBe(0);
  });

  it("does not count a Message the recipient is not allowed to see", async () => {
    // Visibility is filtered in the read model (ADR-0003), so a Message held
    // back by moderation must not raise a badge that points at nothing.
    await graceSends(2);
    await prisma.message.create({
      data: {
        senderId: grace.id,
        conversationId,
        clientMessageId: "blocked-1",
        body: "blocked",
        status: MessageStatus.REJECTED,
      },
    });

    const summaries = await listConversations(ada.id);

    expect(summaries[0]?.unreadCount).toBe(2);
  });
});

describe("otherParticipantOf", () => {
  it("returns the other Participant and their Read Mark", async () => {
    const sent = await graceSends(2);
    await advanceReadMark({ userId: grace.id, conversationId, upTo: sent[1]!.seq });

    const other = await otherParticipantOf(ada.id, conversationId);

    expect(other).toEqual({ userId: grace.id, lastReadSeq: sent[1]!.seq });
  });

  it("reports a Read Mark of zero when the other side has read nothing", async () => {
    await graceSends(1);

    const other = await otherParticipantOf(ada.id, conversationId);

    expect(other).toEqual({ userId: grace.id, lastReadSeq: 0n });
  });

  it("returns null for a Conversation the asker is not in", async () => {
    // Same shape as a Conversation that does not exist, so the answer does not
    // leak which Conversations there are.
    const other = await otherParticipantOf(mallory.id, conversationId);

    expect(other).toBeNull();
  });
});

describe("correspondentsOf", () => {
  it("returns the Users the viewer shares a Conversation with", async () => {
    const correspondents = await correspondentsOf(ada.id);

    expect(correspondents).toEqual([grace.id]);
  });

  it("returns nobody for a User with no Conversations", async () => {
    expect(await correspondentsOf(mallory.id)).toEqual([]);
  });

  it("does not return the viewer themselves", async () => {
    await openConversation({ userId: ada.id, otherUserId: mallory.id });

    const correspondents = await correspondentsOf(ada.id);

    expect(correspondents).toHaveLength(2);
    expect(correspondents).not.toContain(ada.id);
    expect(new Set(correspondents)).toEqual(new Set([grace.id, mallory.id]));
  });
});
