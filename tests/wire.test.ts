import { describe, expect, it } from "vitest";
import { toWireConversation, toWireMessage } from "@/lib/wire";

const message = {
  id: "msg_1",
  seq: 9007199254740993n,
  conversationId: "conv_1",
  senderId: "user_1",
  kind: "TEXT" as const,
  status: "VISIBLE" as const,
  body: "Hello",
  assetUrl: null,
  assetWidth: null,
  assetHeight: null,
  clientMessageId: "client-1",
  moderationReason: null,
  createdAt: new Date("2026-09-05T10:00:00.000Z"),
};

/**
 * ADR-0006: the serialization boundary is where a Sequence stops being a
 * bigint. These tests exist because the failure they guard is silent -- a
 * bigint that reaches JSON.stringify throws, and a Sequence narrowed to a
 * number is wrong invisibly.
 */
describe("toWireMessage", () => {
  it("carries the Sequence as a decimal string", () => {
    expect(toWireMessage(message).seq).toBe("9007199254740993");
  });

  it("survives JSON.stringify, which a bigint would not", () => {
    // The bare row is what throws; the wire shape is what must not.
    expect(() => JSON.stringify(message)).toThrow(TypeError);
    expect(() => JSON.stringify(toWireMessage(message))).not.toThrow();
  });

  it("does not narrow a Sequence past the range a JSON number represents", () => {
    // Round-tripping through a number would land on ...992 -- the exact loss
    // a string prevents.
    const roundTripped = JSON.parse(JSON.stringify(toWireMessage(message)));

    expect(roundTripped.seq).toBe("9007199254740993");
  });

  it("carries the Client Message Id, so a sender can settle its own pending Message", () => {
    expect(toWireMessage(message).clientMessageId).toBe("client-1");
  });

  it("carries createdAt as an ISO string", () => {
    expect(toWireMessage(message).createdAt).toBe("2026-09-05T10:00:00.000Z");
  });
});

describe("toWireConversation", () => {
  const summary = {
    id: "conv_1",
    otherParticipant: { id: "user_2", name: "Grace Hopper", image: null },
    latestMessage: {
      id: "msg_1",
      seq: 42n,
      body: "Hello",
      kind: "TEXT" as const,
      senderId: "user_1",
      createdAt: new Date("2026-09-05T10:00:00.000Z"),
    },
    lastReadSeq: 7n,
    unreadCount: 3,
  };

  it("carries both Sequences as strings", () => {
    const wire = toWireConversation(summary);

    expect(wire.latestMessage?.seq).toBe("42");
    expect(wire.lastReadSeq).toBe("7");
  });

  it("carries the Unread Count as the number it is", () => {
    // A count is not a Sequence: it is bounded by how many Messages exist, not
    // by BIGSERIAL, so it crosses the wire as a number rather than a string.
    expect(toWireConversation(summary).unreadCount).toBe(3);
  });

  it("survives JSON.stringify", () => {
    expect(() => JSON.stringify(toWireConversation(summary))).not.toThrow();
  });

  it("carries a null latest Message through unchanged", () => {
    const wire = toWireConversation({ ...summary, latestMessage: null });

    expect(wire.latestMessage).toBeNull();
    // A Read Mark of zero is still a Sequence, and still a string.
    expect(toWireConversation({ ...summary, lastReadSeq: 0n }).lastReadSeq).toBe("0");
  });
});
