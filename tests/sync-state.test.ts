import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  applyPending,
  applyRetrying,
  applySyncGap,
  emptyConversation,
  highestSequence,
  type ConversationState,
} from "@/lib/conversation-state";
import type { WireMessage } from "@/lib/wire";

function wire(seq: string, overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    id: `msg_${seq}`,
    seq,
    conversationId: "conv_1",
    senderId: "grace",
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

function bodies(state: ConversationState): (string | null)[] {
  return state.entries.map((entry) => entry.body);
}

describe("applySyncGap", () => {
  it("folds in the Messages that arrived while the client was away", () => {
    const held = applyAccepted(emptyConversation(), wire("1"));

    const recovered = applySyncGap(held, [wire("2"), wire("3")]);

    expect(bodies(recovered)).toEqual(["body-1", "body-2", "body-3"]);
  });

  it("delivers a recovered Message exactly once when it also arrives live", () => {
    // The race a reconnect always has: the socket starts broadcasting the
    // moment it is joined, so a Message can arrive both live and in the gap.
    let state = applyAccepted(emptyConversation(), wire("1"));
    state = applyAccepted(state, wire("2"));

    const recovered = applySyncGap(state, [wire("2"), wire("3")]);

    expect(bodies(recovered)).toEqual(["body-1", "body-2", "body-3"]);
  });

  it("settles the sender's own pending Message rather than showing it twice", () => {
    // What a retried send looks like coming back: the client rendered it
    // optimistically, the server had already Accepted it, and it returns in the
    // gap under the Client Message Id the client still holds.
    const pending = applyPending(emptyConversation(), {
      clientMessageId: "client-7",
      senderId: "ada",
      body: "body-7",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const recovered = applySyncGap(pending, [wire("7", { senderId: "ada" })]);

    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]?.pending).toBe(false);
    expect(recovered.entries[0]?.seq).toBe("7");
  });

  it("orders a recovered Message by its Sequence, not by when it was received", () => {
    // A gap arriving after a live Message must not append below it.
    let state = applyAccepted(emptyConversation(), wire("1"));
    state = applyAccepted(state, wire("9"));

    const recovered = applySyncGap(state, [wire("4"), wire("5")]);

    expect(bodies(recovered)).toEqual(["body-1", "body-4", "body-5", "body-9"]);
  });

  it("leaves the paging cursor alone -- a gap is newer history, not older", () => {
    const state: ConversationState = {
      ...applyAccepted(emptyConversation(), wire("5")),
      nextCursor: "5",
      reachedStart: false,
    };

    const recovered = applySyncGap(state, [wire("6")]);

    expect(recovered.nextCursor).toBe("5");
    expect(recovered.reachedStart).toBe(false);
  });

  it("is a no-op when nothing was missed", () => {
    const state = applyAccepted(emptyConversation(), wire("1"));

    expect(applySyncGap(state, [])).toEqual(state);
  });
});

describe("highestSequence as a Sync Cursor", () => {
  it("advances across a drained gap, so the next page asks for what follows", () => {
    let state = applyAccepted(emptyConversation(), wire("1"));
    state = applySyncGap(state, [wire("2"), wire("3")]);

    expect(highestSequence(state)).toBe("3");
  });

  it("compares numerically, so holding 10 does not re-request 9", () => {
    let state = applyAccepted(emptyConversation(), wire("9"));
    state = applySyncGap(state, [wire("10")]);

    expect(highestSequence(state)).toBe("10");
  });

  it("ignores a pending Message, which has no Sequence to claim", () => {
    let state = applyAccepted(emptyConversation(), wire("3"));
    state = applyPending(state, {
      clientMessageId: "client-pending",
      senderId: "ada",
      body: "still sending",
      createdAt: "2026-09-05T11:00:00.000Z",
    });

    expect(highestSequence(state)).toBe("3");
  });
});

describe("applyPending on a Message the Conversation already holds", () => {
  it("does not add a second copy when the retry re-renders it", () => {
    // What a reload does: the outbox retry re-renders the Message as pending
    // while the entry it created before the reload is still held. Appending
    // blindly would show the sender their own Message twice.
    const pending = {
      clientMessageId: "client-retry",
      senderId: "ada",
      body: "Retried after a reload",
      createdAt: "2026-09-05T10:00:00.000Z",
    };
    const state = applyPending(emptyConversation(), pending);

    const again = applyPending(state, pending);

    expect(again.entries).toHaveLength(1);
  });

  it("leaves an already Accepted Message accepted rather than reverting it", () => {
    // The sync settles the Message, then the retry loop re-renders it. Marking
    // it pending again would put a delivered Message back into "Sending...".
    const accepted = applyAccepted(
      emptyConversation(),
      wire("4", { clientMessageId: "client-4", senderId: "ada" }),
    );

    const after = applyPending(accepted, {
      clientMessageId: "client-4",
      senderId: "ada",
      body: "body-4",
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]?.pending).toBe(false);
    expect(after.entries[0]?.seq).toBe("4");
  });
});

describe("applyRetrying", () => {
  it("puts a failed Message back into sending, so the marker matches the attempt", () => {
    // A failed send stays in the outbox and is retried on the next
    // reconnection. Leaving it marked "Not delivered" while it is on the wire
    // tells the sender the opposite of what is happening.
    let state = applyPending(emptyConversation(), {
      clientMessageId: "client-failed",
      senderId: "ada",
      body: "Failed once",
      createdAt: "2026-09-05T10:00:00.000Z",
    });
    state = {
      ...state,
      entries: state.entries.map((entry) => ({
        ...entry,
        pending: false,
        failed: true,
      })),
    };

    const retrying = applyRetrying(state, "client-failed");

    expect(retrying.entries[0]?.pending).toBe(true);
    expect(retrying.entries[0]?.failed).toBe(false);
  });

  it("leaves an Accepted Message alone", () => {
    // The sync may have settled it moments earlier; a retry must not drag a
    // delivered Message back into "Sending...".
    const accepted = applyAccepted(
      emptyConversation(),
      wire("8", { clientMessageId: "client-8", senderId: "ada" }),
    );

    const after = applyRetrying(accepted, "client-8");

    expect(after.entries[0]?.pending).toBe(false);
    expect(after.entries[0]?.seq).toBe("8");
  });

  it("is a no-op for a Message the Conversation does not hold", () => {
    const state = applyAccepted(emptyConversation(), wire("1"));

    expect(applyRetrying(state, "client-unknown")).toEqual(state);
  });
});
