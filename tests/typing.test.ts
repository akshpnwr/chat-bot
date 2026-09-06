import { describe, expect, it } from "vitest";
import { createTypingRegistry, TYPING_TTL_MS } from "@/lib/typing";

/** A clock the test moves by hand, so expiry is asserted rather than waited on. */
function fixedClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("typing", () => {
  it("reports nobody typing in a Conversation nobody is typing in", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);

    expect(typing.typistsIn("conv-1")).toEqual([]);
  });

  it("reports a Participant who has started typing", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);

    typing.startedTyping("conv-1", "ada");

    expect(typing.typistsIn("conv-1")).toEqual(["ada"]);
  });

  it("expires a typist who stops without saying so", () => {
    // The expiry is the whole design: an indicator that must be cleared by a
    // "stopped" event is one a disconnection strands on screen forever.
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");

    clock.advance(TYPING_TTL_MS + 1);

    expect(typing.typistsIn("conv-1")).toEqual([]);
  });

  it("keeps a typist while they are still typing", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");

    // A keystroke just before the deadline renews the lease.
    clock.advance(TYPING_TTL_MS - 1);
    typing.startedTyping("conv-1", "ada");
    clock.advance(TYPING_TTL_MS - 1);

    expect(typing.typistsIn("conv-1")).toEqual(["ada"]);
  });

  it("drops a typist who says they stopped", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");

    typing.stoppedTyping("conv-1", "ada");

    expect(typing.typistsIn("conv-1")).toEqual([]);
  });

  it("drops a typist from every Conversation when they disconnect", () => {
    // A disconnection is not scoped to the Conversation the typist had open,
    // so leaving them typing in another one would strand the indicator there.
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");
    typing.startedTyping("conv-2", "ada");

    typing.userDisconnected("ada");

    expect(typing.typistsIn("conv-1")).toEqual([]);
    expect(typing.typistsIn("conv-2")).toEqual([]);
  });

  it("keeps Conversations separate", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);

    typing.startedTyping("conv-1", "ada");
    typing.startedTyping("conv-2", "grace");

    expect(typing.typistsIn("conv-1")).toEqual(["ada"]);
    expect(typing.typistsIn("conv-2")).toEqual(["grace"]);
  });

  it("keeps typists in one Conversation separate from each other", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);

    typing.startedTyping("conv-1", "ada");
    clock.advance(TYPING_TTL_MS - 1);
    typing.startedTyping("conv-1", "grace");
    clock.advance(2);

    // Ada's lease ran out while Grace's is still live.
    expect(typing.typistsIn("conv-1")).toEqual(["grace"]);
  });

  it("reports whether the Conversation's typists actually changed", () => {
    // A throttled client re-announces typing every few seconds; rebroadcasting
    // an unchanged set would have the recipient re-render on each one.
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);

    expect(typing.startedTyping("conv-1", "ada")).toBe(true);
    expect(typing.startedTyping("conv-1", "ada")).toBe(false);
    expect(typing.stoppedTyping("conv-1", "ada")).toBe(true);
    expect(typing.stoppedTyping("conv-1", "ada")).toBe(false);
  });

  it("forgets a Conversation once its last typist has gone", () => {
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");

    typing.stoppedTyping("conv-1", "ada");

    expect(typing.trackedConversations()).toEqual([]);
  });

  it("forgets a Conversation whose typists have all merely expired", () => {
    // Expiry has no event behind it, so without this the registry would keep a
    // row for every Conversation anybody has ever typed in.
    const clock = fixedClock();
    const typing = createTypingRegistry(clock.now);
    typing.startedTyping("conv-1", "ada");

    clock.advance(TYPING_TTL_MS + 1);
    typing.typistsIn("conv-1");

    expect(typing.trackedConversations()).toEqual([]);
  });
});
