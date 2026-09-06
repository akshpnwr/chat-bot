import { describe, expect, it } from "vitest";
import {
  applyAccepted,
  applyOlderPage,
  applyPending,
  applyPendingAsset,
  applyPendingImage,
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

/**
 * Images in the Conversation value.
 *
 * An image differs from text in three ways the state layer has to carry: it
 * has no body to render, it has intrinsic dimensions the list reserves space
 * from before the bytes arrive, and it can sit PENDING after being Accepted --
 * which text never does, because text moderation is synchronous.
 */
describe("an image Message", () => {
  it("carries its dimensions and kind through into the entry", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", {
        kind: "IMAGE",
        body: null,
        assetUrl: "attachments/k",
        assetWidth: 800,
        assetHeight: 600,
      }),
    );

    const entry = state.entries[0];
    expect(entry?.kind).toBe("IMAGE");
    expect(entry?.assetWidth).toBe(800);
    expect(entry?.assetHeight).toBe(600);
  });

  /**
   * The distinction the sender's spinner is drawn from. A PENDING image has
   * been Accepted -- it has a Sequence -- but has not been classified, so it
   * is neither "sending" nor delivered.
   */
  it("is marked as awaiting moderation while PENDING, though it has a Sequence", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", { kind: "IMAGE", body: null, status: "PENDING" }),
    );

    const entry = state.entries[0];
    expect(entry?.seq).toBe("1");
    expect(entry?.pending).toBe(false);
    expect(entry?.awaitingModeration).toBe(true);
  });

  it("stops awaiting moderation once it is cleared", () => {
    const pending = applyAccepted(
      emptyConversation(),
      wire("1", { kind: "IMAGE", body: null, status: "PENDING" }),
    );
    const cleared = applyAccepted(
      pending,
      wire("1", {
        kind: "IMAGE",
        body: null,
        status: "VISIBLE",
        assetUrl: "attachments/k",
      }),
    );

    expect(cleared.entries).toHaveLength(1);
    expect(cleared.entries[0]?.awaitingModeration).toBe(false);
  });

  /**
   * A refused image stays where it was written, showing why. It is not removed:
   * the sender watched it go, and a bubble that simply vanished would leave
   * them with no account of what happened to it.
   */
  it("becomes a failure carrying the moderation reason when refused", () => {
    const pending = applyAccepted(
      emptyConversation(),
      wire("1", { kind: "IMAGE", body: null, status: "PENDING" }),
    );
    const refused = applyAccepted(
      pending,
      wire("1", {
        kind: "IMAGE",
        body: null,
        status: "REJECTED",
        assetUrl: null,
        moderationReason: "This image appears to contain explicit content",
      }),
    );

    expect(refused.entries).toHaveLength(1);
    const entry = refused.entries[0];
    expect(entry?.failed).toBe(true);
    expect(entry?.failureReason).toBe(
      "This image appears to contain explicit content",
    );
    expect(entry?.awaitingModeration).toBe(false);
  });

  /**
   * The optimistic entry a sender sees between choosing an image and the
   * server accepting it. It holds a local object URL so the sender sees their
   * own picture immediately rather than a grey box.
   */
  it("can be rendered pending from a local preview before it is Accepted", () => {
    const state = applyPendingImage(emptyConversation(), {
      clientMessageId: "client-1",
      senderId: "ada",
      previewUrl: "blob:local-preview",
      assetWidth: 800,
      assetHeight: 600,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const entry = state.entries[0];
    expect(entry?.kind).toBe("IMAGE");
    expect(entry?.pending).toBe(true);
    expect(entry?.seq).toBeNull();
    expect(entry?.previewUrl).toBe("blob:local-preview");
    expect(entry?.assetWidth).toBe(800);
  });

  /**
   * The same rule `applyPending` follows for text: a Message the Conversation
   * already holds is left alone, so a retry cannot drag an Accepted image back
   * into "Sending…".
   */
  it("leaves an Accepted image alone when the pending entry is reapplied", () => {
    const accepted = applyAccepted(
      emptyConversation(),
      wire("1", { kind: "IMAGE", body: null, clientMessageId: "client-1" }),
    );
    const retried = applyPendingImage(accepted, {
      clientMessageId: "client-1",
      senderId: "ada",
      previewUrl: "blob:local-preview",
      assetWidth: 800,
      assetHeight: 600,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(retried.entries).toHaveLength(1);
    expect(retried.entries[0]?.seq).toBe("1");
    expect(retried.entries[0]?.pending).toBe(false);
  });
});

describe("applyPendingAsset", () => {
  /**
   * The optimistic entry for a GIF or a sticker.
   *
   * Unlike an image, it carries the real url from the first frame rather than a
   * local object URL. There is nothing to upload -- the asset already exists at
   * a url both Participants can reach -- so the sender's bubble and the
   * recipient's are the same picture, and settling the send changes only the
   * Sequence.
   */
  it("renders a GIF the sender picked, before the server has answered", () => {
    const state = applyPendingAsset(emptyConversation(), {
      clientMessageId: "client-gif",
      senderId: "ada",
      kind: "GIF",
      assetUrl: "https://media.tenor.com/abc/full.gif",
      body: "a dancing cat",
      assetWidth: 498,
      assetHeight: 362,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const entry = state.entries[0];
    expect(entry?.kind).toBe("GIF");
    expect(entry?.pending).toBe(true);
    expect(entry?.seq).toBeNull();
    expect(entry?.assetUrl).toBe("https://media.tenor.com/abc/full.gif");
  });

  /**
   * The reflow requirement, at the point the bubble is first drawn. The
   * dimensions are known before the send -- from the provider for a GIF, from
   * the registry for a sticker -- so the box is its final size from the first
   * frame rather than growing when the asset loads.
   */
  it("carries the dimensions the bubble reserves its space from", () => {
    const state = applyPendingAsset(emptyConversation(), {
      clientMessageId: "client-sticker",
      senderId: "ada",
      kind: "STICKER",
      assetUrl: "/stickers/reactions/heart.svg",
      body: "Heart",
      assetWidth: 160,
      assetHeight: 160,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(state.entries[0]?.assetWidth).toBe(160);
    expect(state.entries[0]?.assetHeight).toBe(160);
  });

  it("settles into the Accepted Message on its Client Message Id", () => {
    const pending = applyPendingAsset(emptyConversation(), {
      clientMessageId: "client-1",
      senderId: "ada",
      kind: "GIF",
      assetUrl: "https://media.tenor.com/abc/full.gif",
      body: "a dancing cat",
      assetWidth: 498,
      assetHeight: 362,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    const settled = applyAccepted(
      pending,
      wire("1", {
        kind: "GIF",
        body: "a dancing cat",
        assetUrl: "https://media.tenor.com/abc/full.gif",
        assetWidth: 498,
        assetHeight: 362,
      }),
    );

    expect(settled.entries).toHaveLength(1);
    expect(settled.entries[0]?.seq).toBe("1");
    expect(settled.entries[0]?.pending).toBe(false);
  });

  /**
   * The same rule `applyPending` and `applyPendingImage` follow: a Message the
   * Conversation already holds is left alone, so a retry after a reload does
   * not render a second bubble or drag an Accepted one back into "Sending...".
   */
  it("leaves a Message the Conversation already holds exactly as it is", () => {
    const accepted = applyAccepted(
      emptyConversation(),
      wire("1", { kind: "GIF", clientMessageId: "client-1" }),
    );

    const retried = applyPendingAsset(accepted, {
      clientMessageId: "client-1",
      senderId: "ada",
      kind: "GIF",
      assetUrl: "https://media.tenor.com/abc/full.gif",
      body: "a dancing cat",
      assetWidth: 498,
      assetHeight: 362,
      createdAt: "2026-09-05T10:00:00.000Z",
    });

    expect(retried.entries).toHaveLength(1);
    expect(retried.entries[0]?.seq).toBe("1");
    expect(retried.entries[0]?.pending).toBe(false);
  });
});

/**
 * Which kinds carry a URL into client state, and which deliberately do not.
 *
 * An IMAGE's `assetUrl` is a key in a private bucket. Nothing in the browser
 * can fetch it -- the picture is asked for by Message id through the
 * authorized route, so the read model rules on it each time (ADR-0003) -- and
 * putting the object's name in the page would be disclosing where it lives for
 * no one's benefit. A GIF and a sticker are the opposite case: their URLs are
 * already public, and the bubble renders straight from them.
 */
describe("assetUrl on an entry", () => {
  it("is withheld from an image, whose url is a private storage key", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", {
        kind: "IMAGE",
        body: null,
        assetUrl: "attachments/secret-object-key",
        assetWidth: 800,
        assetHeight: 600,
      }),
    );

    expect(state.entries[0]?.assetUrl).toBeNull();
  });

  it("is carried through for a GIF, which renders from it directly", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", {
        kind: "GIF",
        body: "a dancing cat",
        assetUrl: "https://media.tenor.com/abc/full.gif",
        assetWidth: 498,
        assetHeight: 362,
      }),
    );

    expect(state.entries[0]?.assetUrl).toBe("https://media.tenor.com/abc/full.gif");
  });

  it("is carried through for a sticker", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", {
        kind: "STICKER",
        body: "Thumbs up",
        assetUrl: "/stickers/reactions/thumbs-up.svg",
        assetWidth: 160,
        assetHeight: 160,
      }),
    );

    expect(state.entries[0]?.assetUrl).toBe("/stickers/reactions/thumbs-up.svg");
  });

  /**
   * The dimensions are what the bubble reserves its space from, so they must
   * survive for every kind that draws a picture -- including the image, whose
   * URL does not. Without them a virtualized row measures short and grows when
   * the bytes decode, which moves everything below it.
   */
  it("keeps the dimensions a bubble reserves from, even where the url is withheld", () => {
    const state = applyAccepted(
      emptyConversation(),
      wire("1", {
        kind: "IMAGE",
        body: null,
        assetUrl: "attachments/k",
        assetWidth: 800,
        assetHeight: 600,
      }),
    );

    expect(state.entries[0]?.assetWidth).toBe(800);
    expect(state.entries[0]?.assetHeight).toBe(600);
  });
});
