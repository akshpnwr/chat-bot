import { MessageStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { openConversation } from "@/server/conversations";
import { readMessages, readableAsset, sendImageMessage } from "@/server/messages";
import { NotAParticipantError } from "@/server/authorization";
import {
  moderateImageMessage,
  NOT_AN_IMAGE_REASON,
} from "@/server/moderation/pipeline";
import { prisma } from "@/lib/db";

/**
 * The pipeline that carries an Accepted image from PENDING to a decision.
 *
 * Storage and the model are injected rather than reached for, which is what
 * lets these tests state the pipeline's own rules -- what it does with a
 * verdict, and what it does when it cannot reach one -- without a bucket, a
 * 121 MB model load, or explicit imagery in the repository. The rule those
 * probabilities are measured against is tested next door in nudity.test.ts;
 * what is under test here is the sequencing around it.
 */

let ada: Awaited<ReturnType<typeof createUser>>;
let grace: Awaited<ReturnType<typeof createUser>>;
let conversationId: string;

beforeEach(async () => {
  await resetDatabase();
  ada = await createUser("Ada");
  grace = await createUser("Grace");
  const conversation = await openConversation({
    userId: ada.id,
    otherUserId: grace.id,
  });
  conversationId = conversation.id;
});

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

/**
 * A minimal PNG signature, so the object a double hands back is something the
 * pipeline recognises as an image.
 *
 * Real bytes rather than a placeholder string, because the pipeline now sniffs
 * what it read before it classifies it -- a double returning arbitrary text
 * would be refused for not being an image and every test below would be
 * exercising that refusal instead of the case it names.
 */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** Storage doubles: enough surface for the pipeline, none of the bucket. */
function storageDouble() {
  return {
    readObject: vi.fn(async () => PNG_BYTES),
    promote: vi.fn(async (key: string) => key.replace("quarantine/", "attachments/")),
    discard: vi.fn(async () => {}),
  };
}

describe("an image that passes classification", () => {
  it("is promoted out of quarantine and cleared for delivery", async () => {
    const message = await sendImage("clean-1");
    const storage = storageDouble();

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage,
    });

    expect(decided.status).toBe(MessageStatus.VISIBLE);
    expect(decided.assetUrl).toBe("attachments/a-key");
    expect(storage.promote).toHaveBeenCalledWith("quarantine/a-key");
    expect(storage.discard).not.toHaveBeenCalled();
  });

  it("reaches the recipient once cleared", async () => {
    const message = await sendImage("clean-2");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage: storageDouble(),
    });

    const page = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
    });
    expect(page.messages.map((held) => held.id)).toContain(message.id);
  });
});

describe("an image that is refused", () => {
  it("is rejected with the reason the rule gave, and its object deleted", async () => {
    const message = await sendImage("explicit-1");
    const storage = storageDouble();

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({
        refused: true,
        reason: "This image appears to contain explicit content",
      }),
      storage,
    });

    expect(decided.status).toBe(MessageStatus.REJECTED);
    expect(decided.moderationReason).toBe(
      "This image appears to contain explicit content",
    );
    // Cleared as it was rejected, so no row names an object that must not be read.
    expect(decided.assetUrl).toBeNull();
    expect(storage.discard).toHaveBeenCalledWith("quarantine/a-key");
    expect(storage.promote).not.toHaveBeenCalled();
  });

  it("never reaches the recipient", async () => {
    const message = await sendImage("explicit-2");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: true, reason: "explicit" }),
      storage: storageDouble(),
    });

    const page = await readMessages({
      userId: grace.id,
      conversationId,
      limit: 50,
    });
    expect(page.messages.map((held) => held.id)).not.toContain(message.id);
  });
});

/**
 * The failure that matters most. A classifier that throws -- a corrupt upload,
 * a decoder that cannot read the format, the model failing to load -- must not
 * leave the image PENDING forever, and must not wave it through. Failing
 * closed is the only direction that keeps "an explicit image cannot reach the
 * recipient" true when the check itself is what broke.
 */
describe("when classification cannot be completed", () => {
  it("rejects the image rather than delivering an unexamined one", async () => {
    const message = await sendImage("undecidable");
    const storage = storageDouble();

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => {
        throw new Error("decoder blew up");
      },
      storage,
    });

    expect(decided.status).toBe(MessageStatus.REJECTED);
    expect(decided.moderationReason).toMatch(/could not be checked/i);
    expect(storage.discard).toHaveBeenCalledWith("quarantine/a-key");
  });

  it("rejects when the object itself cannot be read back", async () => {
    const message = await sendImage("unreadable");
    const storage = storageDouble();
    storage.readObject.mockRejectedValueOnce(new Error("no such object"));

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage,
    });

    expect(decided.status).toBe(MessageStatus.REJECTED);
  });
});

/**
 * A verdict arriving twice -- a retry, or two workers on the same Message --
 * must not overwrite a decision already made. The guard lives in the message
 * module's WHERE clause; this proves the pipeline does not route around it.
 */
describe("a second verdict on a decided Message", () => {
  it("cannot turn a rejection into a delivery", async () => {
    const message = await sendImage("raced");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: true, reason: "explicit" }),
      storage: storageDouble(),
    });

    const second = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage: storageDouble(),
    });

    expect(second.status).toBe(MessageStatus.REJECTED);
    const held = await prisma.message.findUniqueOrThrow({ where: { id: message.id } });
    expect(held.status).toBe(MessageStatus.REJECTED);
    expect(held.assetUrl).toBeNull();
  });
});

/**
 * The asset route's authorization, which is the same read-model rule as
 * `readMessages` applied to one Message rather than a page.
 *
 * It is tested in its own right because a presigned GET is a capability
 * against the bucket, and the read model (ADR-0003) is the only thing standing
 * between a recipient and an object. A route that authorized by membership
 * alone would hand out a rejected image to anyone in the Conversation --
 * unreachable through history, and perfectly readable through its own URL.
 */
describe("readableAsset", () => {
  it("gives the recipient the key of a cleared image", async () => {
    const message = await sendImage("readable-clean");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage: storageDouble(),
    });

    await expect(
      readableAsset({ userId: grace.id, messageId: message.id }),
    ).resolves.toBe("attachments/a-key");
  });

  it("refuses the recipient a PENDING image, which nobody has looked at yet", async () => {
    const message = await sendImage("readable-pending");

    await expect(
      readableAsset({ userId: grace.id, messageId: message.id }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });

  it("refuses the recipient a REJECTED image", async () => {
    const message = await sendImage("readable-rejected");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: true, reason: "explicit" }),
      storage: storageDouble(),
    });

    await expect(
      readableAsset({ userId: grace.id, messageId: message.id }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });

  it("refuses somebody who is not in the Conversation at all", async () => {
    const mallory = await createUser("Mallory");
    const message = await sendImage("readable-outsider");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage: storageDouble(),
    });

    await expect(
      readableAsset({ userId: mallory.id, messageId: message.id }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });

  /**
   * The sender is the exception, and deliberately so: they see their own
   * Messages at any status, which is what a pending spinner is drawn from.
   * A PENDING image is still theirs to look at -- they chose it.
   */
  it("lets the sender see their own image while it is still PENDING", async () => {
    const message = await sendImage("readable-own-pending");

    await expect(
      readableAsset({ userId: ada.id, messageId: message.id }),
    ).resolves.toBe("quarantine/a-key");
  });

  /**
   * A rejection clears the key, so there is nothing to hand back even to the
   * sender -- the object itself has been deleted.
   */
  it("has nothing to give the sender for a REJECTED image, since the object is gone", async () => {
    const message = await sendImage("readable-own-rejected");
    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: true, reason: "explicit" }),
      storage: storageDouble(),
    });

    await expect(
      readableAsset({ userId: ada.id, messageId: message.id }),
    ).rejects.toBeInstanceOf(NotAParticipantError);
  });
});

/**
 * The declared type is a claim the uploader makes; these are about the bytes
 * disagreeing with it. What the signatures themselves recognise is tested in
 * content-type.test.ts -- what is under test here is that the pipeline asks
 * before it classifies, and refuses rather than delivers when the answer is no.
 */
describe("an object whose bytes are not an image", () => {
  it("is refused without the classifier being asked", async () => {
    const message = await sendImage("renamed-1");
    const storage = storageDouble();
    storage.readObject.mockResolvedValueOnce(
      Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]),
    );
    const classify = vi.fn(async () => ({ refused: false }) as const);

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify,
      storage,
    });

    expect(decided.status).toBe(MessageStatus.REJECTED);
    // The point of sniffing before decoding: an executable never reaches the
    // decoder, so it never becomes an allocation in the process the classifier
    // already lives in.
    expect(classify).not.toHaveBeenCalled();
  });

  it("names a reason distinct from an explicit image", async () => {
    const message = await sendImage("renamed-2");
    const storage = storageDouble();
    storage.readObject.mockResolvedValueOnce(Buffer.from("%PDF-1.7", "ascii"));

    const decided = await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage,
    });

    // A sender who attached the wrong file must not be told their image was
    // explicit, and a sender whose image was explicit must not be told it was
    // the wrong format.
    expect(decided.moderationReason).toBe(NOT_AN_IMAGE_REASON);
  });

  it("is discarded from quarantine rather than promoted", async () => {
    const message = await sendImage("renamed-3");
    const storage = storageDouble();
    storage.readObject.mockResolvedValueOnce(Buffer.from("<svg/>", "utf8"));

    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage,
    });

    expect(storage.promote).not.toHaveBeenCalled();
    expect(storage.discard).toHaveBeenCalledWith("quarantine/a-key");
  });

  it("never reaches the recipient", async () => {
    const message = await sendImage("renamed-4");
    const storage = storageDouble();
    storage.readObject.mockResolvedValueOnce(Buffer.from("not an image", "utf8"));

    await moderateImageMessage({
      messageId: message.id,
      assetKey: "quarantine/a-key",
      classify: async () => ({ refused: false }),
      storage,
    });

    const seen = await readMessages({ userId: grace.id, conversationId, limit: 50 });
    expect(seen.messages.some((held) => held.id === message.id)).toBe(false);
  });
});
