/**
 * The decision half of image moderation: probabilities in, verdict out.
 *
 * Kept in its own module, apart from the classifier that produces those
 * probabilities, for the same reason ADR-0004 gives for the profanity
 * pipeline -- the rule is the deliverable, the model is a swappable
 * dependency. Nothing here imports TensorFlow, so the thresholds can be tested
 * in milliseconds against stated vectors rather than by finding imagery that
 * happens to score near a boundary, and a change that quietly loosens them
 * fails a test rather than passing unnoticed into production.
 *
 * The thresholds themselves, and the reasoning behind their shape, are
 * recorded in ADR-0007.
 */

/**
 * The five classes nsfwjs's MobileNetV2 returns. Named exactly as the model
 * names them -- renaming to something tidier would put a translation step
 * between the model's output and this rule, which is a place for a typo to
 * silently zero a class.
 */
export interface Classification {
  Drawing: number;
  Neutral: number;
  Hentai: number;
  Porn: number;
  Sexy: number;
}

/**
 * Where the two explicit classes, taken together, become a refusal.
 *
 * Together rather than separately: `Porn` and `Sexy` are the model's
 * photographic and drawn readings of the same thing, and an image it splits
 * 0.4/0.4 between them is 80% explicit by its own reckoning while clearing any
 * per-class bar of 0.6.
 */
export const EXPLICIT_THRESHOLD = 0.6;

/**
 * Where `Sexy` alone becomes a refusal.
 *
 * Much higher than the explicit bar, because the class covers swimwear,
 * athletic photography and close-cropped portraits. A moderate score there is
 * ordinary rather than a signal, and a threshold low enough to catch the
 * genuine cases would refuse a photograph from a beach.
 */
export const SUGGESTIVE_THRESHOLD = 0.8;

/** Refused with something to tell the sender, or allowed with nothing to say. */
export type NudityVerdict =
  | { refused: false }
  | {
      refused: true;
      /**
       * Shown to the sender. It names what was detected rather than the score
       * that tripped it: a probability is not something a sender can act on,
       * and publishing the exact figure would hand anyone trying to get an
       * image past the check a gradient to climb.
       */
      reason: string;
    };

/**
 * Rules on an image from its class probabilities.
 *
 * Both comparisons are inclusive at the boundary, so a score landing exactly
 * on a threshold is refused. That direction is deliberate: the two failures
 * are not symmetric -- letting an explicit image through is the one this
 * ticket exists to prevent, and refusing a borderline image costs the sender a
 * retry.
 */
export function classificationVerdict(scores: Classification): NudityVerdict {
  if (scores.Porn + scores.Hentai >= EXPLICIT_THRESHOLD) {
    return { refused: true, reason: "This image appears to contain explicit content" };
  }

  if (scores.Sexy >= SUGGESTIVE_THRESHOLD) {
    return {
      refused: true,
      reason: "This image appears to be sexually suggestive",
    };
  }

  return { refused: false };
}
