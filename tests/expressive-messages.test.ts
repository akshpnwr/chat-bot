import { MessageKind, MessageStatus } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { NotAParticipantError } from "@/server/authorization";
import { openConversation } from "@/server/conversations";
import {
  readMessages,
  sendGifMessage,
  sendStickerMessage,
  syncMessages,
  UnknownStickerError,
} from "@/server/messages";
import { stickerPacks } from "@/lib/sticker-packs";

/**
 * GIFs and stickers, exercised through the routes a recipient actually reads
 * by.
 *
 * The point these tests pin is that both kinds are Accepted VISIBLE rather than
 * PENDING. That is not an oversight of ADR-0003 but its reasoning applied: the
 * asynchronous path exists because an uploaded image is content nobody has
 * looked at, and neither of these is. A sticker ships with the application, and
 * a GIF's URL is one the provider resolved from its own index rather than one
 * the sender named. So there is nothing to wait for, and making the sender
 * watch a spinner would be a delay that buys no safety.
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

const GIF = {
  url: "https://media.tenor.com/abc/full.gif",
  width: 498,
  height: 362,
  description: "a dancing cat",
};

function sendGif(clientMessageId: string) {
  return sendGifMessage({
    senderId: ada.id,
    conversationId,
    clientMessageId,
    gif: GIF,
  });
}

const PACK = stickerPacks()[0]!;
const STICKER = PACK.stickers[0]!;

function sendSticker(clientMessageId: string) {
  return sendStickerMessage({
    senderId: ada.id,
    conversationId,
    clientMessageId,
    packId: PACK.id,
    stickerId: STICKER.id,
  });
}

describe("sendGifMessage", () => {
  it("accepts a GIF as immediately visible", async () => {
    const message = await sendGif("gif-1");

    expect(message.kind).toBe(MessageKind.GIF);
    expect(message.status).toBe(MessageStatus.VISIBLE);
    expect(message.assetUrl).toBe(GIF.url);
  });

  /**
   * The dimensions are what the bubble reserves its space from, so they are
   * stored rather than fetched later -- the same arrangement images use, and
   * for the same reason: a bubble that sized itself when the GIF loaded would
   * reflow the thread at that moment.
   */
  it("stores the dimensions the bubble reserves its space from", async () => {
    const message = await sendGif("gif-1");

    expect(message.assetWidth).toBe(GIF.width);
    expect(message.assetHeight).toBe(GIF.height);
  });

  it("keeps the description, so the bubble has alt text", async () => {
    const message = await sendGif("gif-1");

    expect(message.body).toBe(GIF.description);
  });

  it("reaches the recipient", async () => {
    await sendGif("gif-1");

    const page = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 10,
    });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.kind).toBe(MessageKind.GIF);
    expect(page.messages[0]!.assetUrl).toBe(GIF.url);
  });

  it("reaches a reconnecting recipient through sync", async () => {
    await sendGif("gif-1");

    const gap = await syncMessages({
      userId: grace.id,
      conversationId,
      after: 0n,
    });

    expect(gap.messages).toHaveLength(1);
    expect(gap.messages[0]!.kind).toBe(MessageKind.GIF);
  });

  /**
   * The same idempotency the text and image paths have, and it matters here for
   * the same reason: a retry after an uncertain outcome must settle on the
   * Message the first attempt stored rather than putting a second GIF in the
   * thread.
   */
  it("returns the original Message when a send is retried", async () => {
    const first = await sendGif("gif-1");
    const retried = await sendGif("gif-1");

    expect(retried.id).toBe(first.id);
    expect(retried.seq).toBe(first.seq);

    const page = await readMessages({ userId: ada.id, conversationId, limit: 10 });
    expect(page.messages).toHaveLength(1);
  });

  it("refuses a sender who is not a Participant", async () => {
    await expect(
      sendGifMessage({
        senderId: mallory.id,
        conversationId,
        clientMessageId: "gif-1",
        gif: GIF,
      }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });
});

describe("sendStickerMessage", () => {
  it("accepts a sticker as immediately visible", async () => {
    const message = await sendSticker("sticker-1");

    expect(message.kind).toBe(MessageKind.STICKER);
    expect(message.status).toBe(MessageStatus.VISIBLE);
  });

  /**
   * The URL is built from the registry rather than from the ids as given. A
   * sticker skips classification, so what is stored must be a file the
   * application ships -- not a path assembled from whatever the client sent.
   */
  it("stores the bundled artwork's own url", async () => {
    const message = await sendSticker("sticker-1");

    expect(message.assetUrl).toBe(`/stickers/${PACK.id}/${STICKER.id}.svg`);
    expect(message.assetWidth).toBe(STICKER.width);
    expect(message.assetHeight).toBe(STICKER.height);
  });

  it("keeps the sticker's label as alt text", async () => {
    const message = await sendSticker("sticker-1");

    expect(message.body).toBe(STICKER.label);
  });

  it("reaches the recipient", async () => {
    await sendSticker("sticker-1");

    const page = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 10,
    });

    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.kind).toBe(MessageKind.STICKER);
  });

  /**
   * The registry is the gate, and this is it being shut. An unknown sticker is
   * refused rather than stored with a URL pointing at a file that does not
   * exist -- and, more to the point, rather than letting a crafted id name one
   * that does.
   */
  it("refuses a sticker no bundled pack contains", async () => {
    await expect(
      sendStickerMessage({
        senderId: ada.id,
        conversationId,
        clientMessageId: "sticker-1",
        packId: PACK.id,
        stickerId: "not-a-sticker",
      }),
    ).rejects.toBeInstanceOf(UnknownStickerError);
  });

  it("refuses an id that tries to escape the pack", async () => {
    await expect(
      sendStickerMessage({
        senderId: ada.id,
        conversationId,
        clientMessageId: "sticker-1",
        packId: PACK.id,
        stickerId: "../../../secret",
      }),
    ).rejects.toBeInstanceOf(UnknownStickerError);
  });

  it("returns the original Message when a send is retried", async () => {
    const first = await sendSticker("sticker-1");
    const retried = await sendSticker("sticker-1");

    expect(retried.id).toBe(first.id);

    const page = await readMessages({ userId: ada.id, conversationId, limit: 10 });
    expect(page.messages).toHaveLength(1);
  });

  it("refuses a sender who is not a Participant", async () => {
    await expect(
      sendStickerMessage({
        senderId: mallory.id,
        conversationId,
        clientMessageId: "sticker-1",
        packId: PACK.id,
        stickerId: STICKER.id,
      }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });

  /**
   * Membership is checked before the registry, so a stranger is refused for
   * being a stranger rather than told whether a sticker id exists. It is a mild
   * disclosure, but the ordering costs nothing and the image path is careful
   * about the same thing.
   */
  it("refuses a stranger before it rules on the sticker", async () => {
    await expect(
      sendStickerMessage({
        senderId: mallory.id,
        conversationId,
        clientMessageId: "sticker-1",
        packId: PACK.id,
        stickerId: "not-a-sticker",
      }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });
});
