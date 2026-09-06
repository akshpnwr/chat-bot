import { compareSequence, maxSequence, type Sequence } from "./sequence";
import type { WireMessage } from "./wire";

/**
 * The Conversation's contents, as a value.
 *
 * Every rule about what the reader sees -- ordering, deduplication, and how an
 * optimistically rendered Message settles into an accepted one -- is decided
 * here, in plain functions over plain data, so those rules are testable without
 * a browser and without a socket. The React layer owns scrolling and
 * measurement; it does not own any of this.
 */

/** A Message as rendered, whether or not the server has Accepted it yet. */
export interface ConversationEntry {
  /**
   * The Sequence, or null while the Message is still pending. A pending
   * Message has no Sequence because only acceptance assigns one -- which is
   * why `pending` is not a separate flag that could disagree with it.
   */
  seq: Sequence | null;
  /** Present once accepted; absent while pending. */
  id: string | null;
  clientMessageId: string;
  senderId: string;
  body: string | null;
  createdAt: string;
  /** True until the server has Accepted this Message. */
  pending: boolean;
  /** Set when the send failed, so the reader is told rather than left waiting. */
  failed?: boolean;
  /**
   * Why the send failed, when there is something useful to say -- the term
   * moderation refused it for.
   *
   * Held on the entry rather than in a banner beside the Conversation, because
   * a sender may have written several Messages and only one of them was
   * refused. A notice detached from the Message it refers to leaves them
   * guessing which.
   */
  failureReason?: string;
}

export interface ConversationState {
  /** Oldest first -- the order the Conversation is read in. */
  entries: ConversationEntry[];
  /** The Sequence to request the next older page from, or null at the start. */
  nextCursor: Sequence | null;
  /** True once the whole history is held and there is nothing older to fetch. */
  reachedStart: boolean;
}

export function emptyConversation(): ConversationState {
  return { entries: [], nextCursor: null, reachedStart: false };
}

function toEntry(message: WireMessage): ConversationEntry {
  return {
    seq: message.seq,
    id: message.id,
    clientMessageId: message.clientMessageId,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
    pending: false,
  };
}

/**
 * Orders the Conversation: accepted Messages by Sequence, unaccepted ones by when
 * they were written.
 *
 * A Message without a Sequence is one the server has not accepted -- still in
 * flight, or failed. Both sort by `createdAt` against the accepted Messages
 * around them, which puts a still-sending Message at the bottom where the
 * sender just wrote it, and leaves a failed one where it was written rather
 * than letting it drift below later Messages that did succeed. A failed
 * Message that jumps position is one the sender can no longer find in the
 * Conversation they wrote it in.
 *
 * Comparison of two Sequences goes through the helper (ADR-0006) -- comparing
 * those strings with `<` would put "10" before "9".
 */
function byPosition(a: ConversationEntry, b: ConversationEntry): number {
  if (a.seq !== null && b.seq !== null) return compareSequence(a.seq, b.seq);
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  // Same instant: the accepted Message goes first, since it demonstrably
  // reached the server before the one still waiting on it.
  if (a.seq === null && b.seq !== null) return 1;
  if (a.seq !== null && b.seq === null) return -1;
  return 0;
}

/** Renders a Message the sender has just written, before the server answers. */
export function applyPending(
  state: ConversationState,
  message: {
    clientMessageId: string;
    senderId: string;
    body: string;
    createdAt: string;
  },
): ConversationState {
  // A Message already held is left exactly as it is.
  //
  // The retry path is why. After a reload, the outbox re-renders every
  // unacknowledged Message as pending -- and by then the Conversation may
  // already hold that Message, either as the entry written before the reload or
  // as an Accepted one the reconnect sync recovered. Appending regardless would
  // show the sender their own Message twice, and overwriting would drag an
  // Accepted Message back into "Sending...". Neither is something a retry is
  // entitled to do, so a Message the Conversation knows about is left alone.
  const held = state.entries.some(
    (entry) => entry.clientMessageId === message.clientMessageId,
  );
  if (held) return state;

  const entry: ConversationEntry = {
    seq: null,
    id: null,
    clientMessageId: message.clientMessageId,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
    pending: true,
  };
  return { ...state, entries: [...state.entries, entry].sort(byPosition) };
}

/**
 * Folds an accepted Message in, replacing the pending entry it settles.
 *
 * Matching is on the Client Message Id, which the client generated before the
 * Message left the browser and the server echoes back. That is what makes the
 * settle exact rather than a guess from body text -- and it is the same key the
 * server's idempotency constraint uses, so a retried send settles the same
 * pending Message the first attempt created.
 */
function merge(state: ConversationState, message: WireMessage): ConversationState {
  const entry = toEntry(message);
  const index = state.entries.findIndex(
    (held) =>
      held.clientMessageId === message.clientMessageId || held.id === message.id,
  );

  const entries =
    index === -1
      ? [...state.entries, entry]
      : state.entries.map((held, at) => (at === index ? entry : held));

  return { ...state, entries: entries.sort(byPosition) };
}

/**
 * Folds an Accepted Message in, whether it arrived as the ack for the viewer's
 * own send or as a broadcast over the socket.
 *
 * These are deliberately one function rather than two: the broadcast reaches
 * the sender's own tabs as well as the recipient, so a Message can arrive by
 * both routes, and any difference between how they are folded in would be a
 * difference the sender sees. It also holds the deduplication that makes a
 * re-delivery after reconnect (#7) idempotent at the client, matching the
 * idempotency the server guarantees at the constraint.
 */
export function applyAccepted(
  state: ConversationState,
  message: WireMessage,
): ConversationState {
  return merge(state, message);
}

/**
 * Folds in a page of older history fetched as the reader scrolls upward.
 *
 * The page is deduplicated against what is already held, because a Message can
 * arrive live while the page containing it is in flight. Without that the
 * reader sees it twice at the seam -- a bug that only appears when someone
 * sends while the other side is scrolling back.
 */
export function applyOlderPage(
  state: ConversationState,
  /** Newest first, as the read model returns them. */
  page: WireMessage[],
  nextCursor: Sequence | null,
): ConversationState {
  // Deduplicated on the same identity rule `merge` uses -- the Client Message
  // Id as well as the server id. A Message the viewer sent optimistically can
  // come back in a fetched page before its ack lands, and matching only on the
  // server id would miss it, because a pending entry has no server id yet.
  const heldIds = new Set(state.entries.map((entry) => entry.id));
  const heldClientIds = new Set(state.entries.map((entry) => entry.clientMessageId));
  const older = page
    .filter(
      (message) =>
        !heldIds.has(message.id) && !heldClientIds.has(message.clientMessageId),
    )
    .map(toEntry);

  return {
    entries: [...older, ...state.entries].sort(byPosition),
    nextCursor,
    reachedStart: nextCursor === null,
  };
}

/**
 * The highest Sequence the client holds -- what #7 reports as its Sync Cursor.
 *
 * Pending Messages are skipped: they have no Sequence, and claiming one the
 * client does not hold is exactly the mistake that would make a reconnect skip
 * Messages it never received.
 */
export function highestSequence(state: ConversationState): Sequence | null {
  const held: Sequence[] = [];
  for (const entry of state.entries) {
    if (entry.seq !== null) held.push(entry.seq);
  }
  return maxSequence(held);
}

/**
 * Folds in the Messages a client missed while it was disconnected.
 *
 * This is the same fold as a live Message, applied to a batch -- deliberately,
 * because the two paths overlap. A reconnecting socket joins its rooms and
 * starts receiving broadcasts before, during, or after its sync reply comes
 * back, so a Message that arrived at the moment of reconnection can reach the
 * client by both routes. Sharing `merge` is what makes that overlap invisible:
 * the second arrival matches the first on its id or Client Message Id and
 * replaces it rather than appending a duplicate.
 *
 * Ordering comes from the Sequence, not from arrival, so a gap that lands after
 * a live Message still reads in the order it was written rather than in the
 * order the network happened to deliver it.
 *
 * `nextCursor` and `reachedStart` are untouched. They describe how far back the
 * reader has walked, and a gap is newer history -- moving them would either
 * claim history that was never fetched or re-fetch a page already held.
 */
export function applySyncGap(
  state: ConversationState,
  /** Oldest first, as `syncMessages` returns them. */
  gap: WireMessage[],
): ConversationState {
  return gap.reduce(merge, state);
}

/**
 * Marks a Message as being retried, so what the sender sees matches what is
 * actually happening.
 *
 * A failed send stays in the outbox and goes back on the wire at the next
 * reconnection. Without this, it would still be showing "Not delivered" while
 * it was in flight -- telling the sender the opposite of the truth, and leaving
 * them no way to know a retry had ever been attempted.
 *
 * An Accepted Message is left exactly as it is: the reconnect sync may have
 * settled it moments before the retry loop reached it, and dragging a delivered
 * Message back into "Sending..." would undo that.
 */
export function applyRetrying(
  state: ConversationState,
  clientMessageId: string,
): ConversationState {
  let changed = false;
  const entries = state.entries.map((entry) => {
    if (entry.clientMessageId !== clientMessageId) return entry;
    // Accepted, so there is nothing to retry and nothing to re-mark.
    if (entry.seq !== null) return entry;
    changed = true;
    // The old reason goes with the old failure. A retry that fails again is
    // answered afresh; leaving the previous one showing would attribute the
    // new attempt's outcome to the last attempt's cause.
    return { ...entry, pending: true, failed: false, failureReason: undefined };
  });

  return changed ? { ...state, entries } : state;
}

/**
 * Whether a Message has been read by the other Participant.
 *
 * The Read Mark is a high-water mark rather than a per-Message flag
 * (CONTEXT.md: Read Mark), so this is a comparison rather than a lookup: every
 * Message at or below the mark is read, everything above it is not. That is
 * what lets one number answer the question for ten thousand Messages, and why
 * a receipt cannot disagree with the unread count -- both read the same value.
 *
 * A Message with no Sequence has not been Accepted yet, so it cannot have been
 * read. Returning false for it is not a default: an unsent Message is
 * genuinely unread, and treating a missing Sequence as "at or below" would
 * show a receipt on a Message the recipient has never been sent.
 *
 * The comparison goes through the Sequence helper (ADR-0006) -- comparing the
 * strings directly would report Message "10" as unread against a mark of "9".
 */
export function isRead(
  entry: Pick<ConversationEntry, "seq">,
  otherLastReadSeq: Sequence,
): boolean {
  if (entry.seq === null) return false;
  return compareSequence(entry.seq, otherLastReadSeq) <= 0;
}
