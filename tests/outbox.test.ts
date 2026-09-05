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
