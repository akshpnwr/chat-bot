import { describe, expect, it } from "vitest";
import { createRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * The limiter is a pure value with an injected clock, so every rule below is
 * stated rather than waited on. That is the whole reason the clock is a
 * parameter: a test for "the window rolls forward" written against `Date.now`
 * is a test that either sleeps for a minute or does not test the rolling.
 */

/** A clock the test moves by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows consumption up to the limit", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 }, clock.now);

    expect(limiter.consume("ada").allowed).toBe(true);
    expect(limiter.consume("ada").allowed).toBe(true);
    expect(limiter.consume("ada").allowed).toBe(true);
  });

  it("refuses the request past the limit", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 }, clock.now);

    limiter.consume("ada");
    limiter.consume("ada");

    expect(limiter.consume("ada")).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  it("keys separately, so one user's flood does not refuse another", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, clock.now);

    limiter.consume("ada");

    expect(limiter.consume("ada").allowed).toBe(false);
    expect(limiter.consume("grace").allowed).toBe(true);
  });

  /**
   * The distinguishing property of a sliding window, and the reason it is
   * worth more than a fixed one. A fixed window resets on a boundary, so a
   * sender who spends their whole allowance just before it can spend it all
   * again immediately after -- double the limit across the boundary, which is
   * exactly the burst the limit exists to stop.
   */
  it("refuses a burst that straddles what a fixed window would reset", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 }, clock.now);

    clock.advance(900);
    limiter.consume("ada");
    limiter.consume("ada");

    // Past a fixed window's boundary, but the two attempts above are still
    // within the last second, so the allowance is still spent.
    clock.advance(200);
    expect(limiter.consume("ada").allowed).toBe(false);
  });

  it("allows again once the oldest attempt falls out of the window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 }, clock.now);

    limiter.consume("ada");
    clock.advance(500);
    limiter.consume("ada");
    expect(limiter.consume("ada").allowed).toBe(false);

    // The first attempt is now older than the window; the second is not, so
    // exactly one slot has come back.
    clock.advance(501);
    expect(limiter.consume("ada").allowed).toBe(true);
    expect(limiter.consume("ada").allowed).toBe(false);
  });

  /**
   * The refusal has to tell the caller when to come back, or a client can only
   * guess -- and a guessing client retries immediately, which is the hammering
   * the limit exists to prevent.
   */
  it("names when to retry, counted from the oldest attempt in the window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, clock.now);

    limiter.consume("ada");
    clock.advance(400);

    expect(limiter.consume("ada")).toEqual({ allowed: false, retryAfterMs: 600 });
  });

  /**
   * A refused attempt must not extend its own refusal. If it were recorded,
   * a client that retried steadily would push the oldest attempt forward
   * forever and never be let back in -- a lockout rather than a limit.
   */
  it("does not count a refused attempt against the window", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, clock.now);

    limiter.consume("ada");
    clock.advance(400);
    limiter.consume("ada"); // refused
    clock.advance(601);

    expect(limiter.consume("ada").allowed).toBe(true);
  });

  it("forgets a key whose attempts have all aged out", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000 }, clock.now);

    limiter.consume("ada");
    expect(limiter.trackedKeys()).toEqual(["ada"]);

    clock.advance(1001);
    limiter.consume("grace");

    // Swept on a write rather than by a timer: a process that has seen a
    // million users must not hold a row for each of them forever.
    expect(limiter.trackedKeys()).toEqual(["grace"]);
  });

  /**
   * Sign-in throttling only counts failures, so the limiter needs a way to
   * un-count an attempt that turned out to succeed.
   */
  it("releases an attempt, so a successful sign-in costs nothing", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 }, clock.now);

    limiter.consume("ada@example.com");
    limiter.release("ada@example.com");
    limiter.consume("ada@example.com");
    limiter.consume("ada@example.com");

    expect(limiter.consume("ada@example.com").allowed).toBe(false);
  });

  it("releasing a key with nothing recorded is harmless", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 }, clock.now);

    expect(() => limiter.release("nobody")).not.toThrow();
    expect(limiter.consume("nobody").allowed).toBe(true);
  });
});

describe("RATE_LIMITS", () => {
  /**
   * Asserted as a shape rather than by value: the numbers are a tuning
   * decision that may move, but a limit of zero would refuse everybody and a
   * window of zero would refuse nobody, and both are silent failures.
   */
  it("states a sane limit and window for each guarded action", () => {
    for (const [name, rule] of Object.entries(RATE_LIMITS)) {
      expect(rule.limit, name).toBeGreaterThan(0);
      expect(rule.windowMs, name).toBeGreaterThan(0);
    }
  });
});
