import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { NotAParticipantError } from "@/server/authorization";
import { openConversation } from "@/server/conversations";
import { readMessages, sendMessage } from "@/server/messages";
import { prisma } from "@/lib/db";

let ada: Awaited<ReturnType<typeof createUser>>;
let grace: Awaited<ReturnType<typeof createUser>>;
let conversationId: string;

beforeEach(async () => {
  // Every test file shares one Postgres branch, so each test starts from an
  // empty database rather than inheriting rows another file left behind.
  await resetDatabase();
  ada = await createUser("Ada");
  grace = await createUser("Grace");
  const conversation = await openConversation({
    userId: ada.id,
    otherUserId: grace.id,
  });
  conversationId = conversation.id;
});

describe("sendMessage", () => {
  it("stores a Message and returns it with its server id and sequence", async () => {
    const message = await sendMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId: "11111111-1111-4111-8111-111111111111",
      body: "Hello Grace",
    });

    expect(message.id).toEqual(expect.any(String));
    expect(message.seq).toBeGreaterThan(0n);
    expect(message.body).toBe("Hello Grace");
    expect(message.senderId).toBe(ada.id);
    expect(message.conversationId).toBe(conversationId);
  });
});

describe("sendMessage idempotency", () => {
  it("yields one Message when the same Client Message Id is sent twice, returning the first", async () => {
    const clientMessageId = "22222222-2222-4222-8222-222222222222";
    const first = await sendMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId,
      body: "Sent once",
    });

    // The retry carries a different body, so returning the original rather
    // than overwriting it is observable.
    const second = await sendMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId,
      body: "Retried with different text",
    });

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(second.body).toBe("Sent once");

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });
    expect(page.messages).toHaveLength(1);
  });
});

describe("sendMessage under concurrency", () => {
  it("yields one Message when the same Client Message Id is sent twice at once", async () => {
    const clientMessageId = "33333333-3333-4333-8333-333333333333";
    const send = () =>
      sendMessage({
        senderId: ada.id,
        conversationId,
        clientMessageId,
        body: "Concurrent send",
      });

    // Both calls are in flight before either commits, so a read-then-write
    // check would let them both through. The constraint is what decides.
    const [first, second] = await Promise.all([send(), send()]);

    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });
    expect(page.messages).toHaveLength(1);
  });
});

describe("readMessages", () => {
  /** Sends `count` Messages in order and returns their bodies oldest-first. */
  async function sendSeries(count: number): Promise<string[]> {
    const bodies: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const bodyText = `message-${index}`;
      await sendMessage({
        senderId: index % 2 === 0 ? ada.id : grace.id,
        conversationId,
        clientMessageId: `series-${index}`,
        body: bodyText,
      });
      bodies.push(bodyText);
    }
    return bodies;
  }

  it("returns the most recent Messages first, in sequence order", async () => {
    const bodies = await sendSeries(5);

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });

    expect(page.messages.map((m) => m.body)).toEqual([...bodies].reverse());
    expect(page.nextCursor).toBeNull();
  });

  it("returns contiguous, non-overlapping pages when paging backwards across a boundary", async () => {
    const bodies = await sendSeries(7);

    const first = await readMessages({ userId: ada.id, conversationId, limit: 3 });
    expect(first.nextCursor).not.toBeNull();

    const second = await readMessages({
      userId: ada.id,
      conversationId,
      limit: 3,
      before: first.nextCursor ?? undefined,
    });
    const third = await readMessages({
      userId: ada.id,
      conversationId,
      limit: 3,
      before: second.nextCursor ?? undefined,
    });

    const walked = [...first.messages, ...second.messages, ...third.messages];

    // Every Message appears exactly once, in strict newest-first order:
    // no Message dropped at a boundary, none returned on two pages.
    expect(walked.map((m) => m.body)).toEqual([...bodies].reverse());
    expect(new Set(walked.map((m) => m.id)).size).toBe(bodies.length);
    expect(third.nextCursor).toBeNull();
  });
});

describe("membership guard", () => {
  it("refuses to send for a user who is not a Participant", async () => {
    const mallory = await createUser("Mallory");

    await expect(
      sendMessage({
        senderId: mallory.id,
        conversationId,
        clientMessageId: "44444444-4444-4444-8444-444444444444",
        body: "Let me in",
      }),
    ).rejects.toBeInstanceOf(NotAParticipantError);

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });
    expect(page.messages).toHaveLength(0);
  });

  it("refuses to read for a user who is not a Participant", async () => {
    const mallory = await createUser("Mallory");

    await expect(
      readMessages({ userId: mallory.id, conversationId, limit: 50 }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });
});

/**
 * ADR-0003: the filter lives in the read model, not only in the broadcast path,
 * so a moderation-blocked Message cannot be retrieved by any route -- including
 * pagination. Moderation itself is ticket #9; this ticket owns the read path
 * that must not leak once those statuses start appearing.
 */
describe("readMessages and moderation status", () => {
  /** Writes a Message directly at a given status, as moderation (#9) will. */
  async function sendAt(status: "PENDING" | "REJECTED", senderId: string, key: string) {
    const message = await sendMessage({
      senderId,
      conversationId,
      clientMessageId: key,
      body: `body-${key}`,
    });
    return prisma.message.update({ where: { id: message.id }, data: { status } });
  }

  it("never surfaces a REJECTED Message to the recipient", async () => {
    await sendAt("REJECTED", ada.id, "rejected-1");

    const page = await readMessages({ userId: grace.id, conversationId, limit: 50 });

    expect(page.messages).toHaveLength(0);
  });

  it("never surfaces a PENDING Message to the recipient", async () => {
    await sendAt("PENDING", ada.id, "pending-1");

    const page = await readMessages({ userId: grace.id, conversationId, limit: 50 });

    expect(page.messages).toHaveLength(0);
  });

  it("shows the sender their own PENDING Message", async () => {
    await sendAt("PENDING", ada.id, "pending-2");

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });

    expect(page.messages.map((m) => m.body)).toEqual(["body-pending-2"]);
  });

  it("shows the sender their own REJECTED Message, so a moderation reason can be surfaced", async () => {
    await sendAt("REJECTED", ada.id, "rejected-2");

    const page = await readMessages({ userId: ada.id, conversationId, limit: 50 });

    expect(page.messages.map((m) => m.body)).toEqual(["body-rejected-2"]);
  });
});
