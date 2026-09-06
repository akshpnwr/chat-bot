import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  applyOlderPage,
  applyPending,
  emptyConversation,
  isRead,
  type ConversationState,
} from "@/lib/conversation-state";
import type { WireMessage } from "@/lib/wire";

function wire(seq: string, overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    id: `msg_${seq}`,
    seq,
    conversationId: "conv_1",
    senderId: "ada",
    kind: "TEXT",
    status: "VISIBLE",
    body: `body-${seq}`,
    assetUrl: null,
    assetWidth: null,
    assetHeight: null,
    clientMessageId: `client-${seq}`,
    moderationReason: null,
    createdAt: "2026-09-05T10:00:00.000Z",
    ...overrides,
  };
}

/** The Conversation as rendered: bodies oldest-first. */
function bodies(state: ConversationState): (string | null)[] {
  return state.entries.map((entry) => entry.body);
}

describe("applyPending", () => {
  it("renders the Message immediately, marked pending", () => {
    const state = applyPending(emptyConversation(), {
      clientMessageId: "client-a",
      senderId: "ada",
      body: "Optimistic",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(bodies(state)).toEqual(["Optimistic"]);
    expect(state.entries[0]?.pending).toBe(true);
  });

  it("places a pending Message last, since it is the newest thing in the Conversation", () => {
    const withHistory = applyOlderPage(emptyConversation(), [wire("9"), wire("8")], null);

    const state = applyPending(withHistory, {
      clientMessageId: "client-a",
      senderId: "ada",
      body: "Newest",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(bodies(state)).toEqual(["body-8", "body-9", "Newest"]);
  });
});

describe("a Message that failed to send", () => {
  it("stays where it was written rather than drifting below later Messages", () => {
    // A failed Message that jumps position is one the sender can no longer
    // find in the Conversation they wrote it in.
    let state = applyOlderPage(
      emptyConversation(),
      [wire("1", { createdAt: "2026-09-05T10:00:00.000Z" })],
      null,
    );
    state = applyPending(state, {
      clientMessageId: "client-failed",
      senderId: "ada",
      body: "Failed",
      createdAt: "2026-09-05T10:00:01.000Z",
    });
    // The send is refused, and a later Message is accepted after it.
    state = {
      ...state,
      entries: state.entries.map((entry) =>
        entry.clientMessageId === "client-failed"
          ? { ...entry, pending: false, failed: true }
          : entry,
      ),
    };
    state = applyAccepted(
      state,
      wire("2", { body: "Later, accepted", createdAt: "2026-09-05T10:00:02.000Z" }),
    );

    expect(bodies(state)).toEqual(["body-1", "Failed", "Later, accepted"]);
  });
});

describe("applyAccepted", () => {
  it("settles the pending Message rather than showing it twice", () => {
    const pending = applyPending(emptyConversation(), {
      clientMessageId: "client-5",
      senderId: "ada",
      body: "Optimistic",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const state = applyAccepted(pending, wire("5", { body: "Optimistic" }));

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.pending).toBe(false);
    expect(state.entries[0]?.seq).toBe("5");
  });

  it("keeps the accepted Message when no pending one is held, so an ack is never lost", () => {
    const state = applyAccepted(emptyConversation(), wire("5"));

    expect(bodies(state)).toEqual(["body-5"]);
  });
});

describe("applyAccepted", () => {
  it("appends a Message from the other Participant", () => {
    const state = applyAccepted(applyOlderPage(emptyConversation(), [wire("1")], null), wire("2"));

    expect(bodies(state)).toEqual(["body-1", "body-2"]);
  });

  it("settles the sender's own pending Message, so their other tabs do not double it", () => {
    // The broadcast reaches the sender too; without matching on the Client
    // Message Id the sender would see their own Message twice.
    const pending = applyPending(emptyConversation(), {
      clientMessageId: "client-3",
      senderId: "ada",
      body: "Mine",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const state = applyAccepted(pending, wire("3", { body: "Mine" }));

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]?.pending).toBe(false);
  });

  it("ignores a Message it already holds, so a re-delivery does not duplicate it", () => {
    const first = applyAccepted(emptyConversation(), wire("4"));

    const state = applyAccepted(first, wire("4"));

    expect(state.entries).toHaveLength(1);
  });

  it("orders by Sequence numerically, not lexicographically", () => {
    // ADR-0006: sorting these as strings would put "10" before "9".
    let state = applyAccepted(emptyConversation(), wire("9"));
    state = applyAccepted(state, wire("10"));

    expect(state.entries.map((entry) => entry.seq)).toEqual(["9", "10"]);
  });

  it("places an out-of-order arrival at its Sequence position", () => {
    let state = applyOlderPage(emptyConversation(), [wire("12"), wire("10")], null);
    state = applyAccepted(state, wire("11"));

    expect(state.entries.map((entry) => entry.seq)).toEqual(["10", "11", "12"]);
  });
});

describe("applyOlderPage", () => {
  it("prepends older Messages oldest-first and records the next cursor", () => {
    const recent = applyOlderPage(emptyConversation(), [wire("10"), wire("9")], "9");

    const state = applyOlderPage(recent, [wire("8"), wire("7")], "7");

    expect(state.entries.map((entry) => entry.seq)).toEqual(["7", "8", "9", "10"]);
    expect(state.nextCursor).toBe("7");
  });

  it("marks history exhausted when the cursor comes back null", () => {
    const state = applyOlderPage(emptyConversation(), [wire("1")], null);

    expect(state.nextCursor).toBeNull();
    expect(state.reachedStart).toBe(true);
  });

  it("does not duplicate the viewer's own Message when a page arrives before its ack", () => {
    // The viewer sends; the page containing that Message comes back before the
    // ack does. A pending entry has no server id yet, so matching on the id
    // alone would miss it and the sender would see their own Message twice.
    const pending = applyPending(emptyConversation(), {
      clientMessageId: "client-6",
      senderId: "ada",
      body: "Mine, still in flight",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const state = applyOlderPage(pending, [wire("6", { body: "Mine, accepted" })], null);

    expect(state.entries).toHaveLength(1);
  });

  it("does not duplicate a Message that arrived live while the page was in flight", () => {
    // The live Message lands first; the page that was already in flight
    // includes it. Without dedup the reader sees it twice.
    const live = applyAccepted(emptyConversation(), wire("10"));

    const state = applyOlderPage(live, [wire("10"), wire("9")], "9");

    expect(state.entries.map((entry) => entry.seq)).toEqual(["9", "10"]);
  });
});

describe("highestSequence", () => {
  it("reports the highest Sequence held, which #7's Sync Cursor reads", async () => {
    const { highestSequence } = await import("@/lib/conversation-state");
    let state = applyAccepted(emptyConversation(), wire("9"));
    state = applyAccepted(state, wire("10"));

    expect(highestSequence(state)).toBe("10");
  });

  it("reports null when nothing is held, rather than a Sequence the client does not have", async () => {
    const { highestSequence } = await import("@/lib/conversation-state");

    expect(highestSequence(emptyConversation())).toBeNull();
  });

  it("ignores pending Messages, which have no Sequence yet", async () => {
    const { highestSequence } = await import("@/lib/conversation-state");
    const state = applyPending(applyAccepted(emptyConversation(), wire("5")), {
      clientMessageId: "client-x",
      senderId: "ada",
      body: "Not yet accepted",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(highestSequence(state)).toBe("5");
  });
});

describe("isRead", () => {
  it("reports a Message at the Read Mark as read", () => {
    // The Read Mark is a high-water mark: everything at or before it is read
    // (CONTEXT.md: Read Mark), so the Message it names is itself read.
    expect(isRead(wire("5"), "5")).toBe(true);
  });

  it("reports a Message below the Read Mark as read", () => {
    expect(isRead(wire("3"), "5")).toBe(true);
  });

  it("reports a Message above the Read Mark as unread", () => {
    expect(isRead(wire("7"), "5")).toBe(false);
  });

  it("compares Sequences numerically rather than as text", () => {
    // "10" < "9" lexicographically, which is exactly the bug that would report
    // a read Message as unread once a Conversation passed nine Messages.
    expect(isRead(wire("9"), "10")).toBe(true);
    expect(isRead(wire("10"), "9")).toBe(false);
  });

  it("reports a Message with no Sequence as unread", () => {
    // A pending Message has not reached the server, so it cannot have been
    // read -- and it must not be reported as read because its null compared
    // favourably against something.
    expect(isRead({ ...wire("5"), seq: null }, "5")).toBe(false);
  });

  it("reports nothing as read against a Read Mark of zero", () => {
    expect(isRead(wire("1"), "0")).toBe(false);
  });
});
