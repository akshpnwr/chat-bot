import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { listConversations, openConversation } from "@/server/conversations";
import { sendMessage } from "@/server/messages";
import { prisma } from "@/lib/db";

let ada: Awaited<ReturnType<typeof createUser>>;
let grace: Awaited<ReturnType<typeof createUser>>;
let mallory: Awaited<ReturnType<typeof createUser>>;

beforeEach(async () => {
  await resetDatabase();
  ada = await createUser("Ada");
  grace = await createUser("Grace");
  mallory = await createUser("Mallory");
});

describe("listConversations", () => {
  it("returns the other Participant, so a Conversation can be labelled by who is in it", async () => {
    const conversation = await openConversation({
      userId: ada.id,
      otherUserId: grace.id,
    });

    const [entry] = await listConversations(ada.id);

    expect(entry?.id).toBe(conversation.id);
    expect(entry?.otherParticipant.id).toBe(grace.id);
    expect(entry?.otherParticipant.name).toBe(grace.name);
  });

  it("returns only the viewer's own Conversations", async () => {
    await openConversation({ userId: grace.id, otherUserId: mallory.id });

    expect(await listConversations(ada.id)).toEqual([]);
  });

  it("carries the latest Message so the list can preview it", async () => {
    const conversation = await openConversation({
      userId: ada.id,
      otherUserId: grace.id,
    });
    await sendMessage({
      senderId: ada.id,
      conversationId: conversation.id,
      clientMessageId: "preview-1",
      body: "First",
    });
    const latest = await sendMessage({
      senderId: grace.id,
      conversationId: conversation.id,
      clientMessageId: "preview-2",
      body: "Latest",
    });

    const [entry] = await listConversations(ada.id);

    expect(entry?.latestMessage?.body).toBe("Latest");
    expect(entry?.latestMessage?.seq).toBe(latest.seq);
  });

  it("carries a null latest Message for a Conversation nobody has written into", async () => {
    await openConversation({ userId: ada.id, otherUserId: grace.id });

    const [entry] = await listConversations(ada.id);

    expect(entry?.latestMessage).toBeNull();
  });

  it("orders Conversations by their latest Message, most recent first", async () => {
    const withGrace = await openConversation({ userId: ada.id, otherUserId: grace.id });
    const withMallory = await openConversation({
      userId: ada.id,
      otherUserId: mallory.id,
    });

    await sendMessage({
      senderId: ada.id,
      conversationId: withGrace.id,
      clientMessageId: "order-1",
      body: "Older",
    });
    await sendMessage({
      senderId: ada.id,
      conversationId: withMallory.id,
      clientMessageId: "order-2",
      body: "Newer",
    });

    const entries = await listConversations(ada.id);

    expect(entries.map((entry) => entry.id)).toEqual([withMallory.id, withGrace.id]);
  });

  it("sorts two Conversations with no Messages stably rather than by an invented Sequence", async () => {
    // Neither has a Sequence -- one is not "older" than the other, and a
    // sentinel standing in for the absent Sequence would claim otherwise.
    await openConversation({ userId: ada.id, otherUserId: grace.id });
    await openConversation({ userId: ada.id, otherUserId: mallory.id });

    const entries = await listConversations(ada.id);

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.latestMessage === null)).toBe(true);
  });

  it("sorts a Conversation with no Messages after one that has them", async () => {
    const withGrace = await openConversation({ userId: ada.id, otherUserId: grace.id });
    const empty = await openConversation({ userId: ada.id, otherUserId: mallory.id });
    await sendMessage({
      senderId: ada.id,
      conversationId: withGrace.id,
      clientMessageId: "order-3",
      body: "Has a Message",
    });

    const entries = await listConversations(ada.id);

    expect(entries.map((entry) => entry.id)).toEqual([withGrace.id, empty.id]);
  });

  /**
   * #8 derives the Unread Count from the viewer's Read Mark rather than from a
   * stored counter (CONTEXT.md: "Unread Count: ... Derived, never stored"), so
   * the list carries the Read Mark it will need.
   */
  it("carries the viewer's own Read Mark, not the other Participant's", async () => {
    const conversation = await openConversation({
      userId: ada.id,
      otherUserId: grace.id,
    });
    const message = await sendMessage({
      senderId: ada.id,
      conversationId: conversation.id,
      clientMessageId: "read-mark-1",
      body: "Read by Grace only",
    });
    await prisma.participant.update({
      where: {
        userId_conversationId: { userId: grace.id, conversationId: conversation.id },
      },
      data: { lastReadSeq: message.seq },
    });

    const [forAda] = await listConversations(ada.id);
    const [forGrace] = await listConversations(grace.id);

    expect(forAda?.lastReadSeq).toBe(0n);
    expect(forGrace?.lastReadSeq).toBe(message.seq);
  });

  /**
   * ADR-0003: the recipient must not learn a blocked Message existed -- which
   * includes seeing it quoted as the Conversation's preview in the list.
   */
  it("does not preview a Message the viewer is not allowed to see", async () => {
    const conversation = await openConversation({
      userId: ada.id,
      otherUserId: grace.id,
    });
    const visible = await sendMessage({
      senderId: ada.id,
      conversationId: conversation.id,
      clientMessageId: "visible-1",
      body: "Visible",
    });
    const rejected = await sendMessage({
      senderId: ada.id,
      conversationId: conversation.id,
      clientMessageId: "rejected-1",
      body: "Rejected",
    });
    await prisma.message.update({
      where: { id: rejected.id },
      data: { status: "REJECTED" },
    });

    const [forGrace] = await listConversations(grace.id);
    const [forAda] = await listConversations(ada.id);

    expect(forGrace?.latestMessage?.body).toBe("Visible");
    expect(forGrace?.latestMessage?.seq).toBe(visible.seq);
    // The sender still sees their own, so a moderation reason can reach them.
    expect(forAda?.latestMessage?.body).toBe("Rejected");
  });
});
