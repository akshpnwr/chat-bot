/**
 * How often one caller may do a thing, and what they are told when they have
 * done it too often.
 *
 * The limiter is keyed on the *authenticated user* rather than on the network
 * address. Behind Render's proxy (ADR-0001) every request arrives from the
 * proxy's address, so an address-keyed limit is either one shared bucket for
 * the entire internet or a bucket keyed on an `X-Forwarded-For` header the
 * client itself can write -- the first refuses everybody the moment one person
 * floods, and the second is bypassed by setting a header. A user id is
 * established server-side from the session and cannot be claimed, which is the
 * same property that makes the socket handshake trustworthy.
 *
 * Held in process memory, like presence and typing, and for the same reason:
 * one long-lived Node process (ADR-0001) means the counters and the requests
 * they count are in the same place. What that costs at more than one instance
 * is written down in ADR-0008 rather than left to be discovered.
 *
 * Pure, with the clock injected, so the rules are stated in tests instead of
 * waited on -- the same shape as the typing registry, and for the same reason.
 */

/** A clock, injected so a window is something tests move rather than sleep through. */
export type Clock = () => number;

/** How many attempts are allowed, and over what span. */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * The answer to one attempt.
 *
 * A refusal carries when to come back rather than merely that the caller was
 * refused. Without it a client can only guess, and a guessing client retries
 * immediately -- which is precisely the hammering the limit exists to stop.
 */
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  /**
   * Records an attempt and says whether it may proceed.
   *
   * A refused attempt is deliberately *not* recorded. Recording it would let a
   * client that retries steadily push the window's oldest entry forward
   * forever and never be readmitted -- turning a limit into a lockout, and
   * punishing the well-behaved client that backs off least.
   */
  consume: (key: string) => RateLimitDecision;
  /**
   * Un-records the most recent attempt for a key.
   *
   * This is what lets sign-in throttling count only *failures*: the attempt is
   * consumed before the password is checked, so a flood is refused without the
   * check ever running, and released again when the credentials turn out to be
   * right. Consuming afterwards instead would mean the expensive verification
   * happens first, which is the work the throttle exists to protect.
   */
  release: (key: string) => void;
  /** The keys currently holding attempts. Exposed for tests and diagnostics. */
  trackedKeys: () => string[];
}

/**
 * A sliding window rather than a fixed one.
 *
 * A fixed window resets on a boundary, so a caller who spends their whole
 * allowance just before it can spend it again immediately after -- twice the
 * limit across the boundary, which is the exact burst a limit is for. A
 * sliding window has no boundary to straddle: what counts is always the last
 * `windowMs`, wherever the clock happens to be.
 *
 * The cost is holding a timestamp per attempt rather than a single counter.
 * That is affordable precisely because the limits are small: a bucket can hold
 * at most `limit` entries, since a caller at the limit is refused and refusals
 * are not recorded.
 */
export function createRateLimiter(
  rule: RateLimitRule,
  now: Clock = Date.now,
): RateLimiter {
  /** Key -> the instants of the attempts still inside the window, oldest first. */
  const attempts = new Map<string, number[]>();

  /**
   * Drops attempts that have aged out and returns what is left.
   *
   * It writes as well as reads -- expired entries are removed and a key left
   * with none is forgotten -- which the name says so a caller does not mistake
   * it for a query.
   *
   * Called on every read, which is what keeps the map bounded without a timer.
   * Ageing out is the one way an attempt is forgotten without an event, so a
   * key nobody has used since would otherwise sit in memory for the life of
   * the process -- one row per user who has ever sent a Message.
   */
  function sweepAndRead(key: string): number[] {
    const held = attempts.get(key);
    if (held === undefined) return [];

    const cutoff = now() - rule.windowMs;
    // Sliced from the front rather than filtered: the array is appended to in
    // clock order, so everything expired is a prefix.
    const firstLive = held.findIndex((at) => at > cutoff);
    const live = firstLive === -1 ? [] : held.slice(firstLive);

    if (live.length === 0) {
      attempts.delete(key);
      return [];
    }
    attempts.set(key, live);
    return live;
  }

  return {
    consume(key) {
      const live = sweepAndRead(key);

      if (live.length >= rule.limit) {
        // Counted from the oldest attempt still standing: that is the one whose
        // expiry frees the slot, so this is when a retry can actually succeed
        // rather than a fixed guess that would be refused again on arrival.
        const retryAfterMs = live[0]! + rule.windowMs - now();
        // Floored at a millisecond so a decision taken exactly on the boundary
        // never tells a client to retry in zero -- or, worse, in the past.
        return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
      }

      live.push(now());
      attempts.set(key, live);
      return { allowed: true };
    },

    release(key) {
      const live = sweepAndRead(key);
      if (live.length === 0) return;

      live.pop();
      // Deleted rather than left empty, so releasing the only attempt does not
      // leave a key behind that nothing will ever sweep.
      if (live.length === 0) attempts.delete(key);
      else attempts.set(key, live);
    },

    trackedKeys() {
      // Swept first, so a key whose attempts have all aged out is not reported
      // as tracked merely because nothing has looked at it since.
      for (const key of [...attempts.keys()]) sweepAndRead(key);
      return [...attempts.keys()];
    },
  };
}

/**
 * The limits themselves, gathered here rather than scattered across the call
 * sites that enforce them, so what the service will tolerate can be read in
 * one place and tuned without hunting.
 *
 * All three are set well above what the interface can produce in ordinary use
 * and well below what a script can. The point is not to pace a human -- a
 * person typing fast will never approach thirty Messages in ten seconds -- but
 * to bound what one authenticated account can cost the single process
 * (ADR-0001) when it stops using the interface and starts using a loop.
 */
export const RATE_LIMITS = {
  /**
   * Sending a Message. Generous, because it covers a legitimate burst: a
   * reconnection retries every unacknowledged send in the outbox at once, and
   * a limit that refused those would break reliability in the name of abuse.
   */
  send: { limit: 30, windowMs: 10_000 },
  /**
   * Uploading an image. Much tighter than sending, because each upload buys
   * the sender an inference on the WASM backend (ADR-0007) in a process with
   * 512 MB -- so this is the limit that protects the scarcest resource.
   */
  upload: { limit: 10, windowMs: 60_000 },
  /**
   * Failed sign-in attempts, keyed on the email address rather than on a user
   * id -- there is no session yet, and the address is what a guessing attacker
   * holds fixed while varying the password.
   *
   * Slow enough to make online guessing worthless and loose enough that
   * somebody genuinely mistyping their own password is not locked out for
   * long.
   */
  signIn: { limit: 5, windowMs: 5 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;
