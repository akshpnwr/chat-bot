/**
 * The Messages this browser has sent but the server has not yet Accepted.
 *
 * A Message rendered optimistically lives in React state, which a reload
 * destroys. That is the gap this closes: without it, a sender who writes a
 * Message on a flaky connection and reloads before the ack arrives loses it
 * silently -- the composer cleared, the Message was never stored, and nothing
 * anywhere is still trying. Holding the unacknowledged sends in storage is
 * what lets the retry outlive the page that started it.
 *
 * Retrying is only safe because the Client Message Id is generated before the
 * Message leaves the browser and persisted with it (CONTEXT.md: Client Message
 * Id). The same key retried after a reload settles on the server's idempotency
 * constraint, so a Message the server already Accepted comes back as the
 * original rather than becoming a second one -- which is what makes "delivered
 * on reconnect and appears exactly once" true rather than merely likely.
 */

/** A Message written but not yet Accepted, as it is held between reloads. */
export interface OutboxEntry {
  /** The idempotency key, kept so the retry is the same send, not a new one. */
  clientMessageId: string;
  conversationId: string;
  body: string;
  createdAt: string;
  /**
   * Set on an image send, naming the quarantined object the retry should
   * attach.
   *
   * Only the key is kept, never the bytes. The image is already in object
   * storage by the time an entry is written -- the upload happens before the
   * send -- so a retry has something durable to point at without this browser
   * holding a copy. Putting an 8 MB image in `localStorage` would exhaust a
   * 5 MB quota with a single photograph and take every other Conversation's
   * outbox down with it.
   */
  image?: {
    assetKey: string;
    assetWidth: number;
    assetHeight: number;
  };
}

/**
 * The storage the outbox is kept in -- `localStorage` in the browser, and a
 * plain map in tests. Narrowed to the three methods actually used so the rules
 * here are testable without a DOM.
 */
export interface OutboxStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * Keyed per Conversation rather than one list for all of them: a retry is
 * driven by the Conversation that is open, and scoping the key means reading
 * that Conversation's pending sends never involves filtering another's.
 */
function keyFor(conversationId: string): string {
  return `chat.outbox.${conversationId}`;
}

function isImage(value: unknown): value is NonNullable<OutboxEntry["image"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NonNullable<OutboxEntry["image"]>>;
  return (
    typeof candidate.assetKey === "string" &&
    typeof candidate.assetWidth === "number" &&
    typeof candidate.assetHeight === "number"
  );
}

function isEntry(value: unknown): value is OutboxEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OutboxEntry>;
  if (
    typeof candidate.clientMessageId !== "string" ||
    typeof candidate.conversationId !== "string" ||
    typeof candidate.body !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return false;
  }
  // An image entry is only usable if its whole descriptor survived. A
  // half-written one would be retried as a text Message with an empty body,
  // which is a worse outcome than dropping it.
  return candidate.image === undefined || isImage(candidate.image);
}

/**
 * The unacknowledged Messages for a Conversation, oldest first.
 *
 * Anything unreadable is treated as an empty outbox rather than thrown.
 * Storage is shared with other tabs and survives deploys, so it can hold
 * something this version does not understand -- and a Conversation that
 * refuses to open because of a stale retry entry is a worse failure than a
 * retry that is quietly dropped.
 */
export function loadOutbox(
  store: OutboxStore,
  conversationId: string,
): OutboxEntry[] {
  const raw = store.getItem(keyFor(conversationId));
  if (raw === null) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function save(
  store: OutboxStore,
  conversationId: string,
  entries: OutboxEntry[],
): void {
  if (entries.length === 0) {
    store.removeItem(keyFor(conversationId));
    return;
  }
  store.setItem(keyFor(conversationId), JSON.stringify(entries));
}

/**
 * Records a Message as sent-but-unacknowledged, before it goes over the wire.
 *
 * Recording first is the point: a Message that reaches storage before it
 * reaches the socket is one a reload cannot lose. Recording after the emit
 * would leave a window -- narrow, but exactly the window a flaky connection
 * finds -- in which the Message exists nowhere durable.
 *
 * A Client Message Id already held is left as it was, since a retry is the
 * same send rather than another one.
 */
export function recordSend(store: OutboxStore, entry: OutboxEntry): void {
  const held = loadOutbox(store, entry.conversationId);
  if (held.some((existing) => existing.clientMessageId === entry.clientMessageId)) {
    return;
  }
  save(store, entry.conversationId, [...held, entry]);
}

/**
 * Drops a Message from the outbox once the server has Accepted it.
 *
 * Called when the ack returns, and equally when the Message arrives as a
 * broadcast or in a reconnect sync -- all three mean the same thing, that the
 * server has taken responsibility for it and nothing is owed a retry.
 */
export function settleSend(
  store: OutboxStore,
  conversationId: string,
  clientMessageId: string,
): void {
  const held = loadOutbox(store, conversationId);
  const remaining = held.filter(
    (entry) => entry.clientMessageId !== clientMessageId,
  );
  if (remaining.length === held.length) return;
  save(store, conversationId, remaining);
}

/**
 * The browser's storage, or null where there is none (a server render, or a
 * browser refusing storage in private mode). Null rather than a throw, so the
 * Conversation still works without retry-across-reload rather than not at all.
 */
export function browserOutboxStore(): OutboxStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
