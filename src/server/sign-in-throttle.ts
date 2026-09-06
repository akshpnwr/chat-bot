import {
  createRateLimiter,
  RATE_LIMITS,
  type Clock,
  type RateLimitRule,
} from "@/lib/rate-limit";

/**
 * How often one email address may fail to sign in.
 *
 * This is the one limit that cannot be keyed on a user id, because the whole
 * point is that there is no session yet -- and an attacker guessing passwords
 * has no identity to key on either. What they do hold fixed is the address
 * they are guessing against, so that is the key: it makes online guessing
 * against a particular account slow without letting one attacker slow down
 * everybody else's sign-in.
 *
 * Only *failures* count. A correct sign-in releases its attempt, so somebody
 * using their own account normally never approaches the limit however often
 * they sign in -- which is what the acceptance criterion asks for, and what
 * separates a throttle from a lockout.
 *
 * Kept apart from the hook that installs it (see `src/lib/auth.ts`) so the
 * rules above are stated in tests rather than reached only through a live auth
 * request.
 */

/**
 * What the throttled caller is told.
 *
 * Deliberately vague about *why* beyond the rate. A message naming whether the
 * address exists would make this an account-enumeration oracle -- which is the
 * same reason Better Auth's own failed sign-in does not say which half was
 * wrong.
 */
export const SIGN_IN_THROTTLE_MESSAGE =
  "Too many sign-in attempts. Please wait a moment and try again.";

/** A refusal, or null when the attempt may proceed. */
export interface ThrottleRefusal {
  message: string;
  retryAfterMs: number;
}

export interface SignInThrottle {
  /**
   * Records an attempt against an address, before the password is checked.
   *
   * Before rather than after, so a flood is refused without the verification
   * ever running -- password hashing is deliberately expensive, and making an
   * attacker pay for it on the server's CPU is the resource this protects.
   * Returns a refusal, or null to proceed.
   */
  attempt: (email: unknown) => ThrottleRefusal | null;
  /** Un-records the attempt for an address whose credentials were right. */
  succeeded: (email: unknown) => void;
}

/**
 * Normalizes an address to the key it is counted under.
 *
 * Case and surrounding space are folded, because an address is a
 * case-insensitive identifier and `ADA@example.com` must not be a second
 * allowance against the same account. Returns null for anything that is not a
 * usable address -- see `attempt` for why that is allowed through rather than
 * refused.
 */
function keyFor(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

export function createSignInThrottle(
  rule: RateLimitRule = RATE_LIMITS.signIn,
  now: Clock = Date.now,
): SignInThrottle {
  const limiter = createRateLimiter(rule, now);

  return {
    attempt(email) {
      const key = keyFor(email);
      // A request with no readable address is let through to Better Auth's own
      // validation, which will refuse it. Keying it on a placeholder instead
      // would put every such request in one shared bucket -- a way to exhaust
      // the allowance for the empty string, which protects nothing.
      if (key === null) return null;

      const decision = limiter.consume(key);
      if (decision.allowed) return null;

      return {
        message: SIGN_IN_THROTTLE_MESSAGE,
        retryAfterMs: decision.retryAfterMs,
      };
    },

    succeeded(email) {
      const key = keyFor(email);
      if (key === null) return;
      limiter.release(key);
    },
  };
}
