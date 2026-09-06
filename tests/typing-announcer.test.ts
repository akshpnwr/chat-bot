import { describe, expect, it } from "vitest";
import {
  createTypingAnnouncer,
  TYPING_ANNOUNCE_INTERVAL_MS,
  TYPING_IDLE_MS,
} from "@/lib/typing-announcer";
import { TYPING_TTL_MS } from "@/lib/typing";

/** A clock and a recorder, so throttling is asserted rather than waited on. */
function harness(start = 1_000_000) {
  let now = start;
  const sent: boolean[] = [];
  const announcer = createTypingAnnouncer({
    now: () => now,
    announce: (typing) => sent.push(typing),
  });
  return {
    announcer,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("typing announcer", () => {
  it("announces the first keystroke immediately", () => {
    const { announcer, sent } = harness();

    announcer.keystroke();

    expect(sent).toEqual([true]);
  });

  it("does not announce every keystroke", () => {
    // The acceptance criterion: typing events are throttled rather than
    // emitted per keystroke.
    const { announcer, sent, advance } = harness();

    for (let stroke = 0; stroke < 20; stroke += 1) {
      announcer.keystroke();
      advance(50);
    }

    expect(sent).toEqual([true]);
  });

  it("re-announces once the interval has passed, so the lease is renewed", () => {
    const { announcer, sent, advance } = harness();
    announcer.keystroke();

    advance(TYPING_ANNOUNCE_INTERVAL_MS);
    announcer.keystroke();

    expect(sent).toEqual([true, true]);
  });

  it("renews well before the server's lease lapses", () => {
    // If the interval were not comfortably inside the TTL, a typist would
    // flicker off between renewals -- and a single dropped announcement would
    // clear an indicator that is still true.
    expect(TYPING_ANNOUNCE_INTERVAL_MS * 2).toBeLessThan(TYPING_TTL_MS);
  });

  it("announces a stop once the typist goes idle", () => {
    const { announcer, sent, advance } = harness();
    announcer.keystroke();

    advance(TYPING_IDLE_MS);
    announcer.tick();

    expect(sent).toEqual([true, false]);
  });

  it("does not announce a stop while the typist is still going", () => {
    const { announcer, sent, advance } = harness();
    announcer.keystroke();

    advance(TYPING_IDLE_MS - 1);
    announcer.tick();

    expect(sent).toEqual([true]);
  });

  it("announces a stop only once", () => {
    const { announcer, sent, advance } = harness();
    announcer.keystroke();
    advance(TYPING_IDLE_MS);
    announcer.tick();

    advance(TYPING_IDLE_MS);
    announcer.tick();

    expect(sent).toEqual([true, false]);
  });

  it("announces afresh when typing resumes after going idle", () => {
    const { announcer, sent, advance } = harness();
    announcer.keystroke();
    advance(TYPING_IDLE_MS);
    announcer.tick();

    announcer.keystroke();

    expect(sent).toEqual([true, false, true]);
  });

  it("stops immediately when the Message is sent", () => {
    // Sending is the clearest possible signal that composing has ended, so it
    // must not wait out the idle timer -- the indicator would otherwise linger
    // for seconds after the Message it described has already arrived.
    const { announcer, sent } = harness();
    announcer.keystroke();

    announcer.stop();

    expect(sent).toEqual([true, false]);
  });

  it("says nothing when stopping something that never started", () => {
    const { announcer, sent } = harness();

    announcer.stop();

    expect(sent).toEqual([]);
  });
});
