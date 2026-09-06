import { describe, expect, it } from "vitest";
import { normalizeForMatching, screen } from "@/server/moderation/profanity";

/**
 * The pipeline is the deliverable, not the wordlist (ADR-0004), so these tests
 * exercise it in both directions: a bypass attempt must be caught, and an
 * innocuous word that merely contains a banned substring must not be.
 *
 * They run against the real wordlist rather than an injected fixture, because
 * the swappability the ticket asks for is the file being replaceable -- not the
 * pipeline growing a parameter that only tests ever pass.
 */

describe("normalizeForMatching", () => {
  it("lowercases, strips accents, maps leetspeak and drops non-alphanumerics", () => {
    // `!` folds to `i` along with the other substitutions -- that is what
    // catches `sh!t` -- so trailing punctuation becomes a letter rather than
    // disappearing. Harmless: the match is against a normalized wordlist, and
    // both sides are folded the same way.
    expect(normalizeForMatching("Grâce, W0rld")).toBe("grace world");
  });

  it("collapses runs of a repeated letter to one", () => {
    expect(normalizeForMatching("heeeello")).toBe("helo");
  });

  it("keeps a word boundary where punctuation separated two words", () => {
    // Punctuation between letters of one word is a disguise; punctuation
    // between two words is a boundary the match must not eat.
    expect(normalizeForMatching("well-mannered")).toBe("wel manered");
  });
});

describe("screen", () => {
  it("passes a Message with nothing prohibited in it", () => {
    expect(screen("hello grace, shall we meet at six?")).toEqual({ refused: false });
  });

  it("passes an empty body", () => {
    expect(screen("")).toEqual({ refused: false });
  });

  it("refuses a prohibited word and names the term that tripped it", () => {
    expect(screen("you are a shit")).toEqual({ refused: true, term: "shit" });
  });

  describe("bypass attempts", () => {
    const disguises = [
      ["casing", "SHIT"],
      ["added spaces", "s h i t"],
      ["one space moved", "shi t"],
      ["a split near the front", "s hit"],
      ["punctuation between letters", "s.h.i.t"],
      ["repeated letters", "shiiiit"],
      ["character substitution", "5h1t"],
      ["a masked letter", "sh*t"],
      ["accents", "shít"],
      ["mixed disguises", "S-H-1-T"],
    ] as const;

    for (const [disguise, attempt] of disguises) {
      it(`catches ${disguise}: ${attempt}`, () => {
        expect(screen(`say ${attempt} to that`)).toEqual({ refused: true, term: "shit" });
      });
    }
  });

  it("catches `v` standing in for `u`, the substitution ADR-0004 names", () => {
    // Only this direction is mapped. A `v` stands for a `u` in `fvck`; it
    // stands for an `i` in `shvt`, and one letter cannot fold to two vowels
    // without folding innocuous words together too. The named case is the one
    // the pipeline promises.
    expect(screen("what the fvck")).toEqual({ refused: true, term: "fuck" });
  });

  describe("multi-word terms split anywhere", () => {
    // A term of two words is the case a fragment-only rejoin misses: the
    // halves are both ordinary-length words, so nothing marks them as debris.
    const splits = ["mother fucker", "motherfucker", "mother  fucker", "m0ther fucker"];

    for (const attempt of splits) {
      it(`catches "${attempt}"`, () => {
        expect(screen(attempt)).toEqual({ refused: true, term: "motherfucker" });
      });
    }
  });

  describe("false positives", () => {
    // The Scunthorpe problem: naive substring matching rejects all of these.
    const innocuous = [
      "Scunthorpe",
      "assess the classic",
      "shitake",
      "class assignment",
      "cocktail",
      "analysis",
      "bass",
      // The joining rule must not fuse ordinary adjacent words into a hit.
      "pass the class",
      "a bad ass umption",
      "we can do it",
    ];

    for (const phrase of innocuous) {
      it(`leaves "${phrase}" alone`, () => {
        expect(screen(phrase)).toEqual({ refused: false });
      });
    }
  });
});
