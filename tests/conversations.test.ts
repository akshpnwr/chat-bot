import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { openConversation, SelfConversationError } from "@/server/conversations";
import { readMessages, sendMessage } from "@/server/messages";
import { prisma } from "@/lib/db";

let ada: Awaited<ReturnType<typeof createUser>>;
let grace: Awaited<ReturnType<typeof createUser>>;

beforeEach(async () => {
  // Every test file shares one Postgres branch, so each test starts from an
  // empty database rather than inheriting rows another file left behind.
  await resetDatabase();
  ada = await createUser("Ada");
  grace = await createUser("Grace");
});

describe("openConversation", () => {
  it("reuses the Conversation for a pair rather than duplicating it when reopened", async () => {
    const first = await openConversation({ userId: ada.id, otherUserId: grace.id });

    // Reopened from the other side: still the same thread, not a second one.
    const reopened = await openConversation({ userId: grace.id, otherUserId: ada.id });

    expect(reopened.id).toBe(first.id);
  });

  it("keeps history when the same pair reopens the Conversation", async () => {
    const conversation = await openConversation({ userId: ada.id, otherUserId: grace.id });
    await sendMessage({
      senderId: ada.id,
      conversationId: conversation.id,
      clientMessageId: "reopen-1",
      body: "Before reopening",
    });

    const reopened = await openConversation({ userId: grace.id, otherUserId: ada.id });
    const page = await readMessages({
      userId: grace.id,
      conversationId: reopened.id,
      limit: 50,
    });

    expect(page.messages.map((m) => m.body)).toEqual(["Before reopening"]);
  });

  it("makes both Users Participants, so each can send and read", async () => {
    const conversation = await openConversation({ userId: ada.id, otherUserId: grace.id });

    await sendMessage({
      senderId: grace.id,
      conversationId: conversation.id,
      clientMessageId: "both-1",
      body: "From Grace",
    });
    const page = await readMessages({
      userId: ada.id,
      conversationId: conversation.id,
      limit: 50,
    });

    expect(page.messages.map((m) => m.body)).toEqual(["From Grace"]);
  });
});

describe("openConversation under concurrency", () => {
  it("yields one Conversation when both Users open it at the same time", async () => {
    // Both calls are in flight before either commits, so a read-then-write
    // check would let them both create -- producing exactly the duplicate the
    // pair invariant forbids.
    const [first, second] = await Promise.all([
      openConversation({ userId: ada.id, otherUserId: grace.id }),
      openConversation({ userId: grace.id, otherUserId: ada.id }),
    ]);

    expect(second.id).toBe(first.id);

    const count = await prisma.conversation.count();
    expect(count).toBe(1);
  });
});

describe("openConversation guards", () => {
  it("refuses to open a Conversation between a User and themselves", async () => {
    await expect(
      openConversation({ userId: ada.id, otherUserId: ada.id }),
    ).rejects.toBeInstanceOf(SelfConversationError);
  });
});
