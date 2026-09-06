/**
 * Who is currently typing, and when that stops being true.
 *
 * The ticket asks for an indicator that "disappears on its own if they stop or
 * vanish -- no cleanup path to get wrong", and that phrase is the design.
 * There are three ways typing ends: the typist stops, the typist disconnects,
 * and the typist's browser is closed mid-keystroke with nothing sent at all.
 * An implementation that clears the indicator on an event handles the first
 * two and strands the indicator forever on the third.
 *
 * So typing is held as a lease with a deadline rather than as a flag. A
 * keystroke renews it; anything that stops renewing it lets it lapse. Expiry
 * needs no event, which is exactly why no missing event can defeat it -- the
 * stranded-indicator case is not handled, it is unrepresentable.
 *
 * The lease is evaluated when the state is read rather than swept by a timer.
 * A timer per typist is a cleanup path of its own -- one that has to be
 * cancelled on stop, on disconnect and on shutdown, and that keeps the process
 * awake -- and it would exist only to expire state at a moment when nobody is
 * looking at it. Reading is the only moment the answer matters.
 *
 * In-process, like presence, and for the same reason (ADR-0001).
 */

/**
 * How long a typing announcement stands before it lapses.
 *
 * It has to exceed the client's re-announcement interval or a typist would
 * flicker between announcements; the two are set together, and the client's
 * throttle is deliberately well under half of this so a single dropped
 * announcement does not clear an indicator that is still true.
 */
export const TYPING_TTL_MS = 5_000;

/** A clock, injected so expiry is a value tests can move rather than wait on. */
export type Clock = () => number;

export interface TypingRegistry {
  /**
   * Starts or renews a typist's lease. Returns true when this changed who is
   * typing in the Conversation, so a throttled re-announcement -- which is the
   * common case -- does not cause a rebroadcast.
   */
  startedTyping: (conversationId: string, userId: string) => boolean;
  /** Ends a lease early. Returns true when this changed who is typing. */
  stoppedTyping: (conversationId: string, userId: string) => boolean;
  /**
   * Drops a User from every Conversation at once. A disconnection is not
   * scoped to whichever Conversation they had open, so neither is this.
   * Returns the Conversations whose typists changed, for the caller to
   * rebroadcast.
   */
  userDisconnected: (userId: string) => string[];
  /** Who is typing in a Conversation right now, expired leases excluded. */
  typistsIn: (conversationId: string) => string[];
  /** The Conversations currently holding a lease. Exposed for tests. */
  trackedConversations: () => string[];
}

export function createTypingRegistry(now: Clock = Date.now): TypingRegistry {
  /** Conversation -> typist -> the instant their lease lapses. */
  const leases = new Map<string, Map<string, number>>();

  /**
   * Drops lapsed leases and forgets a Conversation left with none.
   *
   * Called from every read, which is what keeps the map bounded: expiry is the
   * one way a lease ends without an event, so a Conversation nobody is typing
   * in any more would otherwise stay in the map for the life of the process.
   */
  function live(conversationId: string): Map<string, number> | undefined {
    const held = leases.get(conversationId);
    if (!held) return undefined;

    const at = now();
    for (const [userId, expiresAt] of held) {
      if (expiresAt <= at) held.delete(userId);
    }

    if (held.size === 0) {
      leases.delete(conversationId);
      return undefined;
    }
    return held;
  }

  return {
    startedTyping(conversationId, userId) {
      const held = live(conversationId);
      const wasTyping = held?.has(userId) ?? false;

      const renewed = held ?? new Map<string, number>();
      renewed.set(userId, now() + TYPING_TTL_MS);
      leases.set(conversationId, renewed);

      // Renewing an existing lease is not a change to who is typing. The
      // client re-announces every few seconds while somebody composes, and
      // rebroadcasting each one would re-render the recipient on a timer.
      return !wasTyping;
    },

    stoppedTyping(conversationId, userId) {
      const held = live(conversationId);
      if (!held?.delete(userId)) return false;

      if (held.size === 0) leases.delete(conversationId);
      return true;
    },

    userDisconnected(userId) {
      const changed: string[] = [];
      for (const [conversationId, held] of [...leases]) {
        if (!held.delete(userId)) continue;
        changed.push(conversationId);
        if (held.size === 0) leases.delete(conversationId);
      }
      return changed;
    },

    typistsIn(conversationId) {
      return [...(live(conversationId)?.keys() ?? [])];
    },

    trackedConversations() {
      // Read through `live`, so a Conversation whose leases have merely lapsed
      // is reported as gone rather than as present-but-empty.
      for (const conversationId of [...leases.keys()]) live(conversationId);
      return [...leases.keys()];
    },
  };
}
