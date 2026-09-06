import { MessageKind, MessageStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { NotAParticipantError } from "@/server/authorization";
import { openConversation } from "@/server/conversations";
import {
  readMessages,
  rejectImageMessage,
  sendImageMessage,
  syncMessages,
  visibleImageMessage,
} from "@/server/messages";
import { prisma } from "@/lib/db";

/**
 * The asynchronous half of moderation (ADR-0003), exercised through the read
 * model rather than through the broadcast.
 *
 * That choice is what these tests are really about. Proving a rejected image is
 * not broadcast would prove very little: the recipient has three other routes
 * to a Message -- opening the Conversation, paging back through history, and
 * reconnect sync -- and a gate on the broadcast alone leaves all three open.
 * So the assertions below go through the routes themselves.
 */

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

/** Sends an image as Ada and returns it, so each test starts from one. */
function sendImage(clientMessageId: string) {
  return sendImageMessage({
    senderId: ada.id,
    conversationId,
    clientMessageId,
    assetKey: "quarantine/a-key",
    assetWidth: 800,
    assetHeight: 600,
  });
}

describe("sendImageMessage", () => {
  it("Accepts an image as PENDING, so it is stored before it is cleared", async () => {
    const message = await sendImage("11111111-1111-4111-8111-111111111111");

    expect(message.kind).toBe(MessageKind.IMAGE);
    expect(message.status).toBe(MessageStatus.PENDING);
    expect(message.seq).toBeGreaterThan(0n);
  });

  /**
   * The dimensions are the whole reason the schema carries them: the list
   * reserves an image's space before it loads, so the thread does not reflow
   * when it arrives.
   */
  it("stores the intrinsic dimensions, so the list can reserve space", async () => {
    const message = await sendImage("22222222-2222-4222-8222-222222222222");
    expect(message.assetWidth).toBe(800);
    expect(message.assetHeight).toBe(600);
  });

  it("refuses a sender who is not a Participant", async () => {
    await expect(
      sendImageMessage({
        senderId: mallory.id,
        conversationId,
        clientMessageId: "33333333-3333-4333-8333-333333333333",
        assetKey: "quarantine/another",
        assetWidth: 10,
        assetHeight: 10,
      }),
    ).rejects.toBeInstanceOf(NotAParticipantError);

    expect(await prisma.message.count({ where: { conversationId } })).toBe(0);
  });

  it("is idempotent under the same Client Message Id, as a text send is", async () => {
    const clientMessageId = "44444444-4444-4444-8444-444444444444";
    const first = await sendImage(clientMessageId);
    const second = await sendImage(clientMessageId);

    expect(second.id).toBe(first.id);
    expect(await prisma.message.count({ where: { conversationId } })).toBe(1);
  });
});

describe("a PENDING image", () => {
  it("is withheld from the recipient by every read route", async () => {
    await sendImage("55555555-5555-4555-8555-555555555555");

    const history = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
    });
    expect(history.messages).toHaveLength(0);

    const gap = await syncMessages({
      userId: grace.id,
      conversationId,
      after: 0n,
    });
    expect(gap.messages).toHaveLength(0);
  });

  /**
   * The sender does see it, and must -- that is what the spinner is rendered
   * from. A design that hid PENDING from everybody would leave the sender
   * watching an image they sent simply not appear.
   */
  it("is visible to the sender, which is what their spinner is drawn from", async () => {
    await sendImage("66666666-6666-4666-8666-666666666666");

    const own = await readMessages({ userId: ada.id, conversationId, limit: 50 });
    expect(own.messages).toHaveLength(1);
    expect(own.messages[0]?.status).toBe(MessageStatus.PENDING);
  });
});

describe("visibleImageMessage", () => {
  it("clears the image for delivery and points it at the promoted object", async () => {
    const pending = await sendImage("77777777-7777-4777-8777-777777777777");

    const cleared = await visibleImageMessage({
      messageId: pending.id,
      assetUrl: "attachments/a-key",
    });

    expect(cleared.status).toBe(MessageStatus.VISIBLE);
    expect(cleared.assetUrl).toBe("attachments/a-key");
  });

  it("makes the image reachable by the recipient, by every read route", async () => {
    const pending = await sendImage("88888888-8888-4888-8888-888888888888");
    await visibleImageMessage({
      messageId: pending.id,
      assetUrl: "attachments/a-key",
    });

    const history = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
    });
    expect(history.messages).toHaveLength(1);

    const gap = await syncMessages({ userId: grace.id, conversationId, after: 0n });
    expect(gap.messages).toHaveLength(1);
  });
});

describe("rejectImageMessage", () => {
  it("records the refusal and the reason the sender is shown", async () => {
    const pending = await sendImage("99999999-9999-4999-8999-999999999999");

    const refused = await rejectImageMessage({
      messageId: pending.id,
      reason: "This image appears to contain explicit content",
    });

    expect(refused.status).toBe(MessageStatus.REJECTED);
    expect(refused.moderationReason).toBe(
      "This image appears to contain explicit content",
    );
  });

  /**
   * The acceptance criterion this ticket turns on, and the reason ADR-0003
   * puts the filter in the read model: a rejected image must be unreachable by
   * any route, not merely absent from the broadcast.
   */
  it("never reaches the recipient by any route, including pagination and sync", async () => {
    const pending = await sendImage("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await rejectImageMessage({ messageId: pending.id, reason: "explicit" });

    const history = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
    });
    expect(history.messages).toHaveLength(0);

    const gap = await syncMessages({ userId: grace.id, conversationId, after: 0n });
    expect(gap.messages).toHaveLength(0);

    // Paging backwards from above the Message's Sequence is the route a reader
    // scrolling up takes, and is checked separately because it is a different
    // query with a different WHERE clause.
    const older = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
      before: pending.seq + 1n,
    });
    expect(older.messages).toHaveLength(0);
  });

  it("is still shown to the sender, carrying the reason it was refused", async () => {
    const pending = await sendImage("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await rejectImageMessage({
      messageId: pending.id,
      reason: "This image appears to contain explicit content",
    });

    const own = await readMessages({ userId: ada.id, conversationId, limit: 50 });
    expect(own.messages).toHaveLength(1);
    expect(own.messages[0]?.status).toBe(MessageStatus.REJECTED);
    expect(own.messages[0]?.moderationReason).toBe(
      "This image appears to contain explicit content",
    );
  });

  /**
   * A rejected Message keeps its Sequence rather than being deleted, and the
   * recipient's Sequence-based routes simply skip it. Deleting it would leave
   * a hole in the sender's own view of a Conversation they can still see.
   */
  it("leaves the recipient's sync cursor able to pass over it", async () => {
    const rejected = await sendImage("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await rejectImageMessage({ messageId: rejected.id, reason: "explicit" });

    const after = await sendImageMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      assetKey: "quarantine/second",
      assetWidth: 100,
      assetHeight: 100,
    });
    await visibleImageMessage({ messageId: after.id, assetUrl: "attachments/second" });

    const gap = await syncMessages({ userId: grace.id, conversationId, after: 0n });
    expect(gap.messages).toHaveLength(1);
    expect(gap.messages[0]?.id).toBe(after.id);
  });
});
