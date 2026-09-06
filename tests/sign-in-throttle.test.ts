import { describe, expect, it } from "vitest";
import {
  createSignInThrottle,
  SIGN_IN_THROTTLE_MESSAGE,
} from "@/server/sign-in-throttle";

/**
 * The throttle is separated from the auth hook that installs it so its rules
 * can be stated directly. What the hook does is call these two methods on the
 * right paths; what they mean is here.
 */

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe("createSignInThrottle", () => {
  it("allows an attempt while the address is under the limit", () => {
    const throttle = createSignInThrottle({ limit: 3, windowMs: 1000 });

    expect(throttle.attempt("ada@example.com")).toBeNull();
  });

  it("refuses once the address has been tried too often", () => {
    const throttle = createSignInThrottle({ limit: 2, windowMs: 1000 });

    throttle.attempt("ada@example.com");
    throttle.attempt("ada@example.com");

    const refusal = throttle.attempt("ada@example.com");
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toBe(SIGN_IN_THROTTLE_MESSAGE);
    expect(refusal!.retryAfterMs).toBeGreaterThan(0);
  });

  /**
   * Keyed on the address, so one account being guessed at does not lock every
   * other user out of signing in.
   */
  it("throttles each address separately", () => {
    const throttle = createSignInThrottle({ limit: 1, windowMs: 1000 });

    throttle.attempt("ada@example.com");

    expect(throttle.attempt("ada@example.com")).not.toBeNull();
    expect(throttle.attempt("grace@example.com")).toBeNull();
  });

  /**
   * The acceptance criterion says *failed* attempts are throttled. A person
   * who signs in correctly ten times running is not an attack, and a throttle
   * that counted them would lock somebody out of their own account for using
   * it.
   */
  it("does not count an attempt that succeeded", () => {
    const throttle = createSignInThrottle({ limit: 2, windowMs: 1000 });

    throttle.attempt("ada@example.com");
    throttle.succeeded("ada@example.com");
    throttle.attempt("ada@example.com");
    throttle.succeeded("ada@example.com");
    throttle.attempt("ada@example.com");
    throttle.succeeded("ada@example.com");

    expect(throttle.attempt("ada@example.com")).toBeNull();
  });

  it("keeps counting the failures around a success", () => {
    const throttle = createSignInThrottle({ limit: 2, windowMs: 1000 });

    throttle.attempt("ada@example.com"); // failed, stays counted
    throttle.attempt("ada@example.com");
    throttle.succeeded("ada@example.com"); // this one released

    // One failure still stands, so one more is allowed and the next is not.
    expect(throttle.attempt("ada@example.com")).toBeNull();
    expect(throttle.attempt("ada@example.com")).not.toBeNull();
  });

  /**
   * An address is a case-insensitive identifier, so `ADA@example.com` and
   * `ada@example.com` must not be two allowances against one account.
   */
  it("folds case and surrounding space, so one address is one allowance", () => {
    const throttle = createSignInThrottle({ limit: 1, windowMs: 1000 });

    throttle.attempt("ada@example.com");

    expect(throttle.attempt("  ADA@Example.COM ")).not.toBeNull();
  });

  it("lets the address through again once the window has passed", () => {
    const clock = fakeClock();
    const throttle = createSignInThrottle({ limit: 1, windowMs: 1000 }, clock.now);

    throttle.attempt("ada@example.com");
    expect(throttle.attempt("ada@example.com")).not.toBeNull();

    clock.advance(1001);
    expect(throttle.attempt("ada@example.com")).toBeNull();
  });

  /**
   * A request with no readable address cannot be keyed on one. It is allowed
   * through rather than refused: Better Auth will reject it as a bad request
   * anyway, and refusing here would key every such request onto one shared
   * bucket -- which is a way to lock out the empty string, not an attacker.
   */
  it("allows a request with no address to fall through to validation", () => {
    const throttle = createSignInThrottle({ limit: 1, windowMs: 1000 });

    expect(throttle.attempt(undefined)).toBeNull();
    expect(throttle.attempt("")).toBeNull();
    expect(throttle.attempt("   ")).toBeNull();
  });

  /**
   * Two people signing into the same address at once -- or an attacker guessing
   * while the owner signs in. The success must release its own attempt and not
   * the guess, or a guessing run could be sustained indefinitely by waiting for
   * the owner to sign in.
   */
  it("does not let a success refund a concurrent failed guess", () => {
    const throttle = createSignInThrottle({ limit: 3, windowMs: 1000 });

    throttle.attempt("ada@example.com"); // the owner, will succeed
    throttle.attempt("ada@example.com"); // a guess, will fail
    throttle.attempt("ada@example.com"); // a guess, will fail
    throttle.succeeded("ada@example.com");

    // Two failed guesses still stand, so exactly one slot came back.
    expect(throttle.attempt("ada@example.com")).toBeNull();
    expect(throttle.attempt("ada@example.com")).not.toBeNull();
  });

  it("succeeding more often than attempted refunds nothing extra", () => {
    const throttle = createSignInThrottle({ limit: 2, windowMs: 1000 });

    throttle.attempt("ada@example.com");
    throttle.succeeded("ada@example.com");
    // No attempt outstanding; these must not manufacture allowance.
    throttle.succeeded("ada@example.com");
    throttle.succeeded("ada@example.com");

    expect(throttle.attempt("ada@example.com")).toBeNull();
    expect(throttle.attempt("ada@example.com")).toBeNull();
    expect(throttle.attempt("ada@example.com")).not.toBeNull();
  });

  it("succeeding on an address never attempted is harmless", () => {
    const throttle = createSignInThrottle({ limit: 1, windowMs: 1000 });

    expect(() => throttle.succeeded("nobody@example.com")).not.toThrow();
    expect(() => throttle.succeeded(undefined)).not.toThrow();
  });
});
