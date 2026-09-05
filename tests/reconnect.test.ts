import { beforeEach, describe, expect, it } from "vitest";
import { createUser, resetDatabase } from "./setup/database";
import { openConversation } from "@/server/conversations";
import { sendMessage, syncMessages } from "@/server/messages";
import {
  applyAccepted,
  applyPending,
  applySyncGap,
  emptyConversation,
  highestSequence,
  type ConversationState,
} from "@/lib/conversation-state";
import {
  loadOutbox,
  recordSend,
  settleSend,
  type OutboxEntry,
  type OutboxStore,
} from "@/lib/outbox";
import { toWireMessage } from "@/lib/wire";

/**
 * The reconnection guarantees, exercised end to end across the real seam:
 * a real database assigning real Sequences on one side, the real client fold
 * on the other, and the outbox in between.
 *
 * These are the tests that would catch the two mistakes the unit tests cannot
 * see individually -- a client cursor that disagrees with what the server
 * considers missed, and a retry that produces a second Message rather than
 * settling the first.
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

function memoryStore(): OutboxStore {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: (key) => void held.delete(key),
  };
}

/**
 * A client's whole reconnection: drain the gap from the cursor it holds, then
 * retry whatever the gap did not account for. The same order the hook uses.
 */
async function reconnect(
  userId: string,
  state: ConversationState,
  store: OutboxStore,
): Promise<ConversationState> {
  let recovered = state;

  for (;;) {
    const since = highestSequence(recovered);
    const gap = await syncMessages({
      userId,
      conversationId,
      after: since === null ? 0n : BigInt(since),
    });

    recovered = applySyncGap(recovered, gap.messages.map(toWireMessage));
    for (const message of gap.messages) {
      settleSend(store, conversationId, message.clientMessageId);
    }

    if (!gap.hasMore) break;
  }

  // Whatever the gap did not settle was never Accepted, so it goes back out
  // under its original Client Message Id.
  for (const pending of loadOutbox(store, conversationId)) {
    const message = await sendMessage({
      senderId: userId,
      conversationId,
      clientMessageId: pending.clientMessageId,
      body: pending.body,
    });
    settleSend(store, conversationId, pending.clientMessageId);
    recovered = applyAccepted(recovered, toWireMessage(message));
  }

  return recovered;
}

function bodies(state: ConversationState): (string | null)[] {
  return state.entries.map((entry) => entry.body);
}

function outboxEntry(clientMessageId: string, body: string): OutboxEntry {
  return {
    clientMessageId,
    conversationId,
    body,
    createdAt: new Date().toISOString(),
  };
}

describe("a Message sent while disconnected", () => {
  it("is delivered on reconnect and appears exactly once", async () => {
    const store = memoryStore();

    // Written while the socket was down: recorded and rendered, never sent.
    const entry = outboxEntry("offline-1", "Sent while offline");
    recordSend(store, entry);
    let state = applyPending(emptyConversation(), {
      clientMessageId: entry.clientMessageId,
      senderId: ada.id,
      body: entry.body,
      createdAt: entry.createdAt,
    });

    state = await reconnect(ada.id, state, store);

    expect(bodies(state)).toEqual(["Sent while offline"]);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.pending).toBe(false);
    expect(loadOutbox(store, conversationId)).toEqual([]);

    // And exactly one Message reached the database, not two.
    const stored = await syncMessages({ userId: ada.id, conversationId, after: 0n });
    expect(stored.messages).toHaveLength(1);
  });

  it("is not duplicated when the server had already Accepted it", async () => {
    const store = memoryStore();

    // The ack was lost, not the send: the server stored it, the client never
    // heard back, so the Message is still sitting in the outbox.
    const clientMessageId = "ack-lost-1";
    await sendMessage({
      senderId: ada.id,
      conversationId,
      clientMessageId,
      body: "Accepted but unacknowledged",
    });
    recordSend(store, outboxEntry(clientMessageId, "Accepted but unacknowledged"));

    const state = await reconnect(ada.id, emptyConversation(), store);

    expect(state.entries).toHaveLength(1);
    const stored = await syncMessages({ userId: ada.id, conversationId, after: 0n });
    expect(stored.messages).toHaveLength(1);
  });
});

describe("Messages that arrived during a disconnection", () => {
  it("are delivered on reconnect", async () => {
    const store = memoryStore();
    const first = await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "before-1",
      body: "Before the drop",
    });
    let state = applyAccepted(emptyConversation(), toWireMessage(first));

    // Ada is away for these.
    await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "during-1",
      body: "During the drop",
    });
    await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "during-2",
      body: "Also during",
    });

    state = await reconnect(ada.id, state, store);

    expect(bodies(state)).toEqual(["Before the drop", "During the drop", "Also during"]);
  });

  it("recovers everything after a long absence, not just the recent ones", async () => {
    const store = memoryStore();
    // Wider than one sync page, so a single round cannot be enough.
    const total = 250;
    await prismaBulkSend(total);

    const state = await reconnect(ada.id, emptyConversation(), store);

    expect(state.entries).toHaveLength(total);
    expect(bodies(state)).toEqual(
      Array.from({ length: total }, (_unused, index) => `long-${index}`),
    );
  });

  it("delivers exactly once when the transport also replayed its buffer", async () => {
    // What a reconnection actually looks like: Socket.IO's own short-gap
    // recovery replays the Messages it buffered, and the sync returns the same
    // ones from the database. Both routes fold through the same merge, so the
    // overlap has to be invisible.
    const store = memoryStore();
    const replayed = await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "replayed-1",
      body: "Replayed by the transport",
    });

    let state = applyAccepted(emptyConversation(), toWireMessage(replayed));
    state = await reconnect(ada.id, state, store);

    expect(bodies(state)).toEqual(["Replayed by the transport"]);
  });
});

describe("the same account in two tabs", () => {
  it("gives both tabs every Message exactly once", async () => {
    const storeA = memoryStore();
    const storeB = memoryStore();

    await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "shared-1",
      body: "To both tabs",
    });

    const tabA = await reconnect(ada.id, emptyConversation(), storeA);
    const tabB = await reconnect(ada.id, emptyConversation(), storeB);

    expect(bodies(tabA)).toEqual(["To both tabs"]);
    expect(bodies(tabB)).toEqual(["To both tabs"]);
  });

  it("yields one Message when both tabs retry the same outbox entry", async () => {
    // Two tabs share one localStorage, so both can wake up holding the same
    // unacknowledged send. The Client Message Id is what keeps that from
    // becoming two Messages.
    const storeA = memoryStore();
    const storeB = memoryStore();
    const entry = outboxEntry("two-tabs-1", "Written in one tab");
    recordSend(storeA, entry);
    recordSend(storeB, entry);

    const tabA = await reconnect(ada.id, emptyConversation(), storeA);
    const tabB = await reconnect(ada.id, emptyConversation(), storeB);

    expect(tabA.entries).toHaveLength(1);
    expect(tabB.entries).toHaveLength(1);

    const stored = await syncMessages({ userId: ada.id, conversationId, after: 0n });
    expect(stored.messages).toHaveLength(1);
  });
});

describe("a server restart mid-conversation", () => {
  it("loses no Accepted Message and duplicates none", async () => {
    const store = memoryStore();

    const before = await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "restart-before",
      body: "Before the restart",
    });
    let state = applyAccepted(emptyConversation(), toWireMessage(before));

    // A Message Accepted just as the process dies: durably stored, but its
    // broadcast never left, and the transport's replay buffer died with the
    // process. Only the cursor sync can recover this one.
    await sendMessage({
      senderId: grace.id,
      conversationId,
      clientMessageId: "restart-during",
      body: "Accepted as the server died",
    });

    // And one this client wrote, whose ack the dying server never sent.
    const unacknowledged = outboxEntry("restart-unacked", "Written into the void");
    recordSend(store, unacknowledged);
    state = applyPending(state, {
      clientMessageId: unacknowledged.clientMessageId,
      senderId: ada.id,
      body: unacknowledged.body,
      createdAt: unacknowledged.createdAt,
    });

    // The restarted server holds no in-memory state at all; recovery asks the
    // database, which is the only thing that survived.
    state = await reconnect(ada.id, state, store);

    expect(bodies(state)).toEqual([
      "Before the restart",
      "Accepted as the server died",
      "Written into the void",
    ]);
    expect(state.entries.every((entry) => !entry.pending)).toBe(true);

    const stored = await syncMessages({ userId: ada.id, conversationId, after: 0n });
    expect(stored.messages).toHaveLength(3);
  });
});

/** Bulk-inserts Messages from Grace, bypassing the send path they don't test. */
async function prismaBulkSend(total: number): Promise<void> {
  const { prisma } = await import("@/lib/db");
  await prisma.message.createMany({
    data: Array.from({ length: total }, (_unused, index) => ({
      conversationId,
      senderId: grace.id,
      clientMessageId: `long-${index}`,
      body: `long-${index}`,
    })),
  });
}
