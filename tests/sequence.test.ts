import { describe, expect, it } from "vitest";
import {
  compareSequence,
  isAfter,
  maxSequence,
  type Sequence,
} from "@/lib/sequence";

/**
 * ADR-0006: a Sequence crosses the wire as a decimal string, and every
 * comparison goes through this one helper. The tests that matter are the ones
 * a bare `<` would fail -- string comparison is lexicographic, so "10" < "9"
 * is true and any inline comparison is wrong the moment a Conversation passes
 * nine Messages.
 */
describe("compareSequence", () => {
  it("orders by numeric value, not lexicographically", () => {
    // The whole point: "10" < "9" under string comparison.
    expect(compareSequence("10", "9")).toBeGreaterThan(0);
    expect(compareSequence("9", "10")).toBeLessThan(0);
    expect(compareSequence("7", "7")).toBe(0);
  });

  it("orders correctly across digit-count boundaries", () => {
    expect(compareSequence("100", "99")).toBeGreaterThan(0);
    expect(compareSequence("1000", "999")).toBeGreaterThan(0);
  });

  it("orders values beyond the range a JSON number represents exactly", () => {
    // 2^53 and 2^53 + 1 are the same double; as strings they are distinct.
    expect(compareSequence("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
  });

  it("sorts a page of Sequences into ascending order", () => {
    const page: Sequence[] = ["10", "9", "100", "1", "20"];

    expect([...page].sort(compareSequence)).toEqual(["1", "9", "10", "20", "100"]);
  });
});

describe("isAfter", () => {
  it("reports whether the first Sequence is strictly later than the second", () => {
    expect(isAfter("10", "9")).toBe(true);
    expect(isAfter("9", "10")).toBe(false);
    expect(isAfter("9", "9")).toBe(false);
  });
});

describe("maxSequence", () => {
  it("returns the highest Sequence numerically", () => {
    // What #7's reconnect sync reports: the highest Sequence the client holds.
    expect(maxSequence(["9", "10", "8"])).toBe("10");
  });

  it("returns null for an empty list, so a caller cannot mistake a default for a held Sequence", () => {
    expect(maxSequence([])).toBeNull();
  });
});
