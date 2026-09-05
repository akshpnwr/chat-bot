import { beforeEach, describe, expect, it } from "vitest";
import { MessageStatus } from "@prisma/client";
import { createUser, resetDatabase } from "./setup/database";
import { NotAParticipantError } from "@/server/authorization";
import { openConversation } from "@/server/conversations";
import { sendMessage, syncMessages, SYNC_PAGE_LIMIT } from "@/server/messages";
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

describe("syncMessages", () => {
  it("returns only Messages after the Sync Cursor, oldest first", async () => {
    const sent = await graceSends(4);
    const cursor = sent[1]!.seq;

    const gap = await syncMessages({
      userId: ada.id,
      conversationId,
      after: cursor,
    });

    expect(gap.messages.map((message) => message.body)).toEqual(["m-2", "m-3"]);
    expect(gap.hasMore).toBe(false);
  });

  it("returns the whole Conversation when the client holds nothing", async () => {
    await graceSends(3);

    const gap = await syncMessages({
      userId: ada.id,
      conversationId,
      after: 0n,
    });

    expect(gap.messages.map((message) => message.body)).toEqual(["m-0", "m-1", "m-2"]);
  });

  it("returns nothing when the client is already up to date", async () => {
    const sent = await graceSends(2);

    const gap = await syncMessages({
      userId: ada.id,
      conversationId,
      after: sent[1]!.seq,
    });

    expect(gap.messages).toEqual([]);
    expect(gap.hasMore).toBe(false);
  });

  it("bounds a long absence into pages that can be drained in order", async () => {
    // More than one page, so a client returning after a long absence has to be
    // told there is more rather than silently losing the remainder. Written in
    // one insert rather than 200 sends: what is under test is how a wide gap is
    // bounded and drained, not the send path those rows would go through.
    const total = SYNC_PAGE_LIMIT + 5;
    await prisma.message.createMany({
      data: Array.from({ length: total }, (_unused, index) => ({
        conversationId,
        senderId: grace.id,
        clientMessageId: `bulk-${index}`,
        body: `m-${index}`,
      })),
    });

    const first = await syncMessages({ userId: ada.id, conversationId, after: 0n });
    expect(first.messages).toHaveLength(SYNC_PAGE_LIMIT);
    expect(first.hasMore).toBe(true);

    // Draining continues from the highest Sequence the client now holds --
    // the same cursor rule, applied again.
    const second = await syncMessages({
      userId: ada.id,
      conversationId,
      after: first.messages.at(-1)!.seq,
    });
    expect(second.messages).toHaveLength(5);
    expect(second.hasMore).toBe(false);

    const recovered = [...first.messages, ...second.messages].map((m) => m.body);
    expect(recovered).toEqual(
      Array.from({ length: total }, (_unused, index) => `m-${index}`),
    );
  });

  it("is strictly ascending, so the drained cursor always advances", async () => {
    await graceSends(5);

    const gap = await syncMessages({ userId: ada.id, conversationId, after: 0n });

    const sequences = gap.messages.map((message) => message.seq);
    const ascending = [...sequences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sequences).toEqual(ascending);
  });

  it("refuses a user who is not a Participant", async () => {
    await graceSends(1);

    await expect(
      syncMessages({ userId: mallory.id, conversationId, after: 0n }),
    ).rejects.toThrow(NotAParticipantError);
  });

  it("withholds a Message that failed moderation from the recipient", async () => {
    const [visible, rejected] = (await graceSends(2)) as [
      Awaited<ReturnType<typeof sendMessage>>,
      Awaited<ReturnType<typeof sendMessage>>,
    ];
    await prisma.message.update({
      where: { id: rejected.id },
      data: { status: MessageStatus.REJECTED, moderationReason: "blocked" },
    });

    const forRecipient = await syncMessages({
      userId: ada.id,
      conversationId,
      after: 0n,
    });
    expect(forRecipient.messages.map((m) => m.id)).toEqual([visible.id]);

    // The sender still sees their own, which is how a moderation reason
    // reaches them after a reconnect.
    const forSender = await syncMessages({
      userId: grace.id,
      conversationId,
      after: 0n,
    });
    expect(forSender.messages.map((m) => m.id)).toEqual([visible.id, rejected.id]);
  });
});
