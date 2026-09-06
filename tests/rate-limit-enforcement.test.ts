import { describe, expect, it } from "vitest";
import { createRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";
import { createSignInThrottle } from "@/server/sign-in-throttle";

/**
 * What the configured limits actually do to the flows they guard.
 *
 * The limiter's own rules are stated in rate-limit.test.ts against arbitrary
 * numbers; these are about the numbers the service ships with, and about the
 * two properties that are decided by how the limiter is *wired* rather than by
 * how it counts: that one allowance is shared across every kind of send, and
 * that a reconnection's burst of retries fits inside it.
 */

describe("the send limit", () => {
  /**
   * The reason `send` is the most generous of the three. A reconnection
   * retries every unacknowledged Message in the outbox at once, and a limit
   * that refused those would break the reliability guarantee in the name of
   * abuse -- the Messages would sit in the outbox unsent while the client
   * believed it had retried them.
   */
  it("admits a reconnection's whole burst of retries", () => {
    const limiter = createRateLimiter(RATE_LIMITS.send);

    // A plausible worst case for one person composing offline.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(limiter.consume("ada").allowed, `retry ${attempt}`).toBe(true);
    }
  });

  it("refuses a script sending faster than any person types", () => {
    const limiter = createRateLimiter(RATE_LIMITS.send);

    let refusedAt: number | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!limiter.consume("ada").allowed) {
        refusedAt = attempt;
        break;
      }
    }

    expect(refusedAt).not.toBeNull();
    expect(refusedAt).toBe(RATE_LIMITS.send.limit);
  });

  /**
   * One limiter covers text, images, GIFs and stickers together, which is what
   * the socket server wires up. Four separate allowances would let a script
   * spend all of them at once for four times the traffic, against a process
   * that has one set of resources rather than four.
   */
  it("is one allowance across every kind of Message", () => {
    const limiter = createRateLimiter(RATE_LIMITS.send);
    const kinds = ["text", "image", "gif", "sticker"];

    // Spent round-robin, exactly as a client alternating kinds would.
    for (let attempt = 0; attempt < RATE_LIMITS.send.limit; attempt += 1) {
      expect(limiter.consume("ada").allowed, kinds[attempt % kinds.length]).toBe(true);
    }

    // The next send of any kind is refused, because the allowance was shared.
    expect(limiter.consume("ada").allowed).toBe(false);
  });

  it("does not let one sender's flood refuse another", () => {
    const limiter = createRateLimiter(RATE_LIMITS.send);

    for (let attempt = 0; attempt < RATE_LIMITS.send.limit; attempt += 1) {
      limiter.consume("ada");
    }

    expect(limiter.consume("ada").allowed).toBe(false);
    expect(limiter.consume("grace").allowed).toBe(true);
  });
});

describe("the upload limit", () => {
  /**
   * Tighter than sending, deliberately: every upload buys the sender an object
   * in the bucket and an inference on the WASM backend inside a 512 MB process
   * (ADR-0001, ADR-0007), which is the scarcest thing an authenticated caller
   * can spend.
   */
  it("is stricter than the send limit, per unit of time", () => {
    const sendRate = RATE_LIMITS.send.limit / RATE_LIMITS.send.windowMs;
    const uploadRate = RATE_LIMITS.upload.limit / RATE_LIMITS.upload.windowMs;

    expect(uploadRate).toBeLessThan(sendRate);
  });

  it("names when to retry, so a refused client can back off", () => {
    const limiter = createRateLimiter(RATE_LIMITS.upload);

    for (let attempt = 0; attempt < RATE_LIMITS.upload.limit; attempt += 1) {
      limiter.consume("ada");
    }

    const refusal = limiter.consume("ada");
    expect(refusal.allowed).toBe(false);
    if (refusal.allowed) return;
    expect(refusal.retryAfterMs).toBeGreaterThan(0);
    expect(refusal.retryAfterMs).toBeLessThanOrEqual(RATE_LIMITS.upload.windowMs);
  });
});

describe("the sign-in throttle", () => {
  it("stops an online guessing run within a handful of attempts", () => {
    const throttle = createSignInThrottle();

    let refusedAt: number | null = null;
    for (let guess = 0; guess < 100; guess += 1) {
      if (throttle.attempt("ada@example.com") !== null) {
        refusedAt = guess;
        break;
      }
    }

    expect(refusedAt).toBe(RATE_LIMITS.signIn.limit);
  });

  /**
   * The property that separates a throttle from a lockout: somebody using
   * their own account correctly is never refused, however often they sign in.
   */
  it("never refuses an account signing in successfully", () => {
    const throttle = createSignInThrottle();

    for (let signIn = 0; signIn < 100; signIn += 1) {
      expect(throttle.attempt("ada@example.com"), `sign-in ${signIn}`).toBeNull();
      throttle.succeeded("ada@example.com");
    }
  });

  it("does not let one address being guessed at lock out another", () => {
    const throttle = createSignInThrottle();

    for (let guess = 0; guess < RATE_LIMITS.signIn.limit + 5; guess += 1) {
      throttle.attempt("ada@example.com");
    }

    expect(throttle.attempt("ada@example.com")).not.toBeNull();
    expect(throttle.attempt("grace@example.com")).toBeNull();
  });
});
