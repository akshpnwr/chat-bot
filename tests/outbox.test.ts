import { beforeEach, describe, expect, it } from "vitest";
import {
  loadOutbox,
  recordSend,
  settleSend,
  type OutboxEntry,
  type OutboxStore,
} from "@/lib/outbox";

/** A localStorage stand-in, so the outbox is tested without a browser. */
function memoryStore(seed: Record<string, string> = {}): OutboxStore {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

const conversationId = "conv_1";

function entry(clientMessageId: string, body = `body-${clientMessageId}`): OutboxEntry {
  return {
    clientMessageId,
    conversationId,
    body,
    createdAt: "2026-09-05T10:00:00.000Z",
  };
}

let store: OutboxStore;

beforeEach(() => {
  store = memoryStore();
});

describe("recordSend", () => {
  it("holds a Message that has not been acknowledged", () => {
    recordSend(store, entry("a"));

    expect(loadOutbox(store, conversationId)).toEqual([entry("a")]);
  });

  it("survives a reload -- the outbox is read back from storage, not memory", () => {
    recordSend(store, entry("a"));
    recordSend(store, entry("b"));

    // A fresh reader over the same storage is what a reloaded page is.
    const afterReload = loadOutbox(store, conversationId);

    expect(afterReload.map((held) => held.clientMessageId)).toEqual(["a", "b"]);
  });

  it("keeps send order, so a retried burst arrives as it was written", () => {
    recordSend(store, entry("a"));
    recordSend(store, entry("b"));
    recordSend(store, entry("c"));

    expect(loadOutbox(store, conversationId).map((h) => h.body)).toEqual([
      "body-a",
      "body-b",
      "body-c",
    ]);
  });

  it("records the same Client Message Id once, however often it is retried", () => {
    recordSend(store, entry("a"));
    recordSend(store, entry("a"));

    expect(loadOutbox(store, conversationId)).toHaveLength(1);
  });
});

describe("settleSend", () => {
  it("drops a Message once the server has Accepted it", () => {
    recordSend(store, entry("a"));
    recordSend(store, entry("b"));

    settleSend(store, conversationId, "a");

    expect(loadOutbox(store, conversationId).map((h) => h.clientMessageId)).toEqual(["b"]);
  });

  it("is a no-op for a Message the outbox does not hold", () => {
    recordSend(store, entry("a"));

    settleSend(store, conversationId, "never-sent");

    expect(loadOutbox(store, conversationId)).toHaveLength(1);
  });
});

describe("outbox scoping", () => {
  it("keeps Conversations apart, so a retry cannot land in the wrong one", () => {
    recordSend(store, entry("a"));
    recordSend(store, { ...entry("b"), conversationId: "conv_2" });

    expect(loadOutbox(store, conversationId).map((h) => h.clientMessageId)).toEqual(["a"]);
    expect(loadOutbox(store, "conv_2").map((h) => h.clientMessageId)).toEqual(["b"]);
  });
});

describe("loadOutbox", () => {
  it("reads an empty outbox as empty rather than failing", () => {
    expect(loadOutbox(store, conversationId)).toEqual([]);
  });

  it("recovers from corrupted storage rather than breaking the Conversation", () => {
    const corrupted = memoryStore({ "chat.outbox.conv_1": "{not json" });

    expect(loadOutbox(corrupted, conversationId)).toEqual([]);
  });

  it("discards a stored entry that is not a well-formed Message", () => {
    const malformed = memoryStore({
      "chat.outbox.conv_1": JSON.stringify([{ clientMessageId: "a" }, entry("b")]),
    });

    expect(loadOutbox(malformed, conversationId).map((h) => h.clientMessageId)).toEqual([
      "b",
    ]);
  });
});

/**
 * A GIF or sticker in the outbox.
 *
 * These survive a reload where an image does not, and the reason is what these
 * tests pin: the descriptor is a handful of identifiers and a public URL
 * rather than bytes, so it costs nothing to keep -- and the URL still resolves
 * on the page that reads it back, so a retried bubble can show its picture.
 *
 * The half-written cases matter for the same reason the image ones do. An
 * entry missing part of its descriptor would be retried as a text Message with
 * an empty body, which is a worse outcome than dropping it.
 */
describe("expressive sends in the outbox", () => {
  const gifEntry: OutboxEntry = {
    ...entry("gif-a", "a dancing cat"),
    asset: {
      kind: "GIF",
      gifId: "abc123",
      assetUrl: "https://media.tenor.com/abc/full.gif",
      assetWidth: 498,
      assetHeight: 362,
    },
  };

  const stickerEntry: OutboxEntry = {
    ...entry("sticker-a", "Thumbs up"),
    asset: {
      kind: "STICKER",
      packId: "reactions",
      stickerId: "thumbs-up",
      assetUrl: "/stickers/reactions/thumbs-up.svg",
      assetWidth: 160,
      assetHeight: 160,
    },
  };

  it("keeps a GIF's descriptor across a reload", () => {
    recordSend(store, gifEntry);

    expect(loadOutbox(store, conversationId)[0]!.asset).toEqual(gifEntry.asset);
  });

  it("keeps a sticker's descriptor across a reload", () => {
    recordSend(store, stickerEntry);

    expect(loadOutbox(store, conversationId)[0]!.asset).toEqual(stickerEntry.asset);
  });

  /**
   * The identifiers are what the retry sends; the URL beside them only draws
   * the bubble. Keeping both is what lets a reloaded page show the picture
   * while still sending by id -- which is the separation the whole GIF path
   * rests on.
   */
  it("keeps the id the retry sends by, not only the url it draws from", () => {
    recordSend(store, gifEntry);

    const held = loadOutbox(store, conversationId)[0]!;
    expect(held.asset).toMatchObject({ kind: "GIF", gifId: "abc123" });
  });

  it("discards a GIF entry with no id to send by", () => {
    const malformed = memoryStore({
      "chat.outbox.conv_1": JSON.stringify([
        {
          ...entry("broken"),
          asset: {
            kind: "GIF",
            assetUrl: "https://media.tenor.com/abc/full.gif",
            assetWidth: 498,
            assetHeight: 362,
          },
        },
        stickerEntry,
      ]),
    });

    expect(loadOutbox(malformed, conversationId).map((h) => h.clientMessageId)).toEqual([
      "sticker-a",
    ]);
  });

  it("discards a sticker entry missing the dimensions its bubble reserves", () => {
    const malformed = memoryStore({
      "chat.outbox.conv_1": JSON.stringify([
        {
          ...entry("broken"),
          asset: { kind: "STICKER", packId: "reactions", stickerId: "heart" },
        },
        gifEntry,
      ]),
    });

    expect(loadOutbox(malformed, conversationId).map((h) => h.clientMessageId)).toEqual([
      "gif-a",
    ]);
  });

  it("discards an entry naming a kind of asset there is no way to send", () => {
    const malformed = memoryStore({
      "chat.outbox.conv_1": JSON.stringify([
        {
          ...entry("broken"),
          asset: {
            kind: "VIDEO",
            assetUrl: "https://example.test/clip.mp4",
            assetWidth: 640,
            assetHeight: 480,
          },
        },
      ]),
    });

    expect(loadOutbox(malformed, conversationId)).toEqual([]);
  });

  it("still settles an expressive send when the server accepts it", () => {
    recordSend(store, gifEntry);
    settleSend(store, conversationId, "gif-a");

    expect(loadOutbox(store, conversationId)).toEqual([]);
  });
});
