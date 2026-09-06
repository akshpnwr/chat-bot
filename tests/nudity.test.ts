import { describe, expect, it } from "vitest";
import {
  EXPLICIT_THRESHOLD,
  SUGGESTIVE_THRESHOLD,
  classificationVerdict,
  type Classification,
} from "@/server/moderation/nudity-rule";

/**
 * The threshold rule, tested as the pure function it is.
 *
 * These tests deliberately do not run the model. The rule is the part this
 * project decided (ADR-0007) and the part a change could silently loosen; the
 * weights are a vendored dependency whose accuracy is not ours to assert. So
 * the input here is a probability vector, which is precisely what the model
 * hands the rule -- exercising the decision without a 74 MB load or a
 * dependency on imagery that cannot live in a repository.
 */

/** A full vector, so a test states every class rather than relying on defaults. */
function scores(partial: Partial<Classification>): Classification {
  return { Drawing: 0, Neutral: 0, Hentai: 0, Porn: 0, Sexy: 0, ...partial };
}

describe("classificationVerdict", () => {
  it("allows an ordinary photograph", () => {
    const verdict = classificationVerdict(scores({ Neutral: 0.97, Drawing: 0.02 }));
    expect(verdict.refused).toBe(false);
  });

  it("refuses an explicit image", () => {
    const verdict = classificationVerdict(scores({ Porn: 0.94, Sexy: 0.05 }));
    expect(verdict.refused).toBe(true);
  });

  it("refuses explicit drawn imagery, which is the Hentai class", () => {
    const verdict = classificationVerdict(scores({ Hentai: 0.91, Drawing: 0.08 }));
    expect(verdict.refused).toBe(true);
  });

  /**
   * The reason the rule sums the two explicit classes rather than thresholding
   * each on its own. An image split evenly between them is explicit by the
   * model's own reckoning, and no per-class threshold of 0.6 would see it.
   */
  it("refuses an image the model splits between the two explicit classes", () => {
    const verdict = classificationVerdict(scores({ Porn: 0.4, Hentai: 0.4, Sexy: 0.2 }));
    expect(verdict.refused).toBe(true);
    expect(classificationVerdict(scores({ Porn: 0.4 })).refused).toBe(false);
    expect(classificationVerdict(scores({ Hentai: 0.4 })).refused).toBe(false);
  });

  it("allows swimwear and athletic photographs, which score Sexy but not highly", () => {
    const verdict = classificationVerdict(scores({ Sexy: 0.55, Neutral: 0.4 }));
    expect(verdict.refused).toBe(false);
  });

  it("refuses an overwhelmingly suggestive image", () => {
    const verdict = classificationVerdict(scores({ Sexy: 0.86, Neutral: 0.1 }));
    expect(verdict.refused).toBe(true);
  });

  // The boundary is stated in the test rather than left to be discovered from
  // a rounding difference in production.
  it("treats each threshold as inclusive at its exact boundary", () => {
    expect(classificationVerdict(scores({ Porn: EXPLICIT_THRESHOLD })).refused).toBe(true);
    expect(classificationVerdict(scores({ Sexy: SUGGESTIVE_THRESHOLD })).refused).toBe(true);
  });

  it("allows an image a hair under each threshold", () => {
    expect(
      classificationVerdict(scores({ Porn: EXPLICIT_THRESHOLD - 0.001 })).refused,
    ).toBe(false);
    expect(
      classificationVerdict(scores({ Sexy: SUGGESTIVE_THRESHOLD - 0.001 })).refused,
    ).toBe(false);
  });

  /**
   * The sender is told why, in the same spirit as the profanity refusal naming
   * its term: a bare "rejected" leaves them unable to tell a moderation
   * decision from a bug.
   */
  it("gives the sender a reason naming what was detected", () => {
    const explicit = classificationVerdict(scores({ Porn: 0.95 }));
    expect(explicit.refused && explicit.reason).toMatch(/explicit/i);

    const suggestive = classificationVerdict(scores({ Sexy: 0.9 }));
    expect(suggestive.refused && suggestive.reason).toMatch(/sexually suggestive/i);
  });
});
