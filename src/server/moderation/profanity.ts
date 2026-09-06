import wordlist from "./wordlist.json" with { type: "json" };

/**
 * The profanity pipeline: content in, decision out.
 *
 * A pure function over a string, with no database, no session and no socket
 * anywhere near it -- which is what lets every bypass attempt and every false
 * positive be a unit test rather than an end-to-end one (ADR-0004). The
 * wordlist is a separate file, so swapping it for a managed list or a service
 * is a change to data rather than to this module.
 *
 * The pipeline is deliberately hand-rolled rather than imported. The task asks
 * for a defensible moderation pipeline, so each step below has to be one that
 * can be explained and pointed at -- which a library's internals are not.
 */

/**
 * Number-and-symbol-for-letter substitutions, applied after case folding.
 *
 * Only the substitutions people actually use to slip a word past a filter are
 * here. Mapping every visually similar glyph would widen the collapse below
 * until unrelated words started colliding -- the pipeline is meant to resist
 * simple bypasses, not to normalize every string to the same one.
 */
const LEET: Record<string, string> = {
  "4": "a",
  "@": "a",
  "3": "e",
  "1": "i",
  "!": "i",
  "|": "i",
  "0": "o",
  "5": "s",
  $: "s",
  "7": "t",
  // `v` for `u` is not a number-for-letter substitution but a letter-for-letter
  // one, and it is the disguise ADR-0004 names (`fvck`). It is safe only
  // because it maps toward the vowel: no wordlist term contains a `v`, so this
  // cannot fold an innocuous `v` word onto a banned one.
  v: "u",
};

/**
 * The characters `LEET` maps, as one alternation.
 *
 * Derived from the map rather than written out beside it, so adding a
 * substitution is one edit. The two drifting apart is a silent failure -- the
 * entry sits in the map looking applied while the pattern never selects it.
 */
const LEET_PATTERN = new RegExp(
  // Every mapped character is escaped, because the map holds regex
  // metacharacters (`$`, `|`) that would otherwise change what the class means
  // rather than being matched literally.
  `[${Object.keys(LEET)
    .map((character) => character.replace(/[^a-z0-9]/g, "\\$&"))
    .join("")}]`,
  "g",
);

/** A run of the same character becomes one of it: `fuuuck` -> `fuck`. */
function collapseRuns(text: string): string {
  return text.replace(/(.)\1+/g, "$1");
}

/**
 * Folds a string to the form matching is done in.
 *
 * Order matters, and each step defeats one specific disguise:
 *
 * 1. Lowercase                     -- `SHIT`
 * 2. Strip diacritics              -- `shít`
 * 3. Map leetspeak                 -- `5h1t`
 * 4. Non-alphanumerics to spaces   -- `s.h.i.t`
 * 5. Collapse repeated characters  -- `shiiiit`
 * 6. Squeeze runs of spaces
 *
 * Step 4 turns separators into spaces rather than deleting them, which is the
 * decision the Scunthorpe problem turns on. Deleting them would fuse
 * `class assignment` into one word containing a banned term; keeping them as
 * boundaries means the spaced-out disguise `s h i t` is handled by the
 * anchored joining passes in `screen` rather than by destroying every word
 * boundary in the Message up front.
 *
 * ADR-0004 originally specified the opposite -- strip, and collapse first --
 * and has been updated to this order, with the reasoning recorded there.
 *
 * Step 5 collapses runs to a single character, so `heeeello` and `hello` fold
 * to the same `helo`. Every term in the wordlist is folded the same way, so
 * the two sides always agree about what a collapsed word looks like.
 */

export function normalizeForMatching(content: string): string {
  const lowered = content.toLowerCase();

  // NFKD splits an accented letter into its base plus a combining mark, and the
  // range below drops the marks -- so `í` becomes `i` rather than a character
  // no rule below would recognize.
  const unaccented = lowered.normalize("NFKD").replace(/[̀-ͯ]/g, "");

  const substituted = unaccented.replace(
    LEET_PATTERN,
    (character) => LEET[character] ?? character,
  );

  const separated = substituted.replace(/[^a-z0-9]+/g, " ");

  return collapseRuns(separated).trim();
}

/**
 * The wordlist as the pipeline matches against it: every term folded through
 * the same normalization the Message is.
 *
 * Folded once at module load rather than per Message, and folded rather than
 * trusted, so a wordlist entry written with an accent or a repeated letter
 * still matches -- the file is data somebody edits by hand, and it should not
 * have to know how the pipeline spells things internally.
 */
const PROHIBITED: ReadonlyMap<string, string> = new Map(
  wordlist.terms.map((term) => [normalizeForMatching(term), term] as const),
);

/** The decision: either the content is clean, or one term refused it. */
export type Screening =
  | { refused: false }
  | {
      refused: true;
      /** The term as the wordlist spells it, so the sender is told what tripped it. */
      term: string;
    };

/**
 * Screens content against the wordlist.
 *
 * Matching happens on two readings of the same normalized text, because the
 * two disguises pull in opposite directions:
 *
 *  - Whole words, matched exactly. This is the boundary rule, and it is what
 *    makes `Scunthorpe`, `assess` and `shitake` send normally -- a banned term
 *    appearing inside a longer word is not the word.
 *  - The same words with every space removed, matched only where the term
 *    begins at the start of some word and ends at the end of some word. This
 *    is what catches a term broken up anywhere -- `f u c k`, `f.u.c.k`,
 *    `shi t`, `mother fucker` -- without a rule about how big the pieces are.
 *
 * The anchoring is what keeps the second pass from re-introducing the
 * Scunthorpe problem. Joining the words of `pass the class` gives
 * `passtheclass`, which contains `ass` -- but not starting at any word start,
 * so it is not a match. `bad ass umption` is refused for the same reason
 * `badass` would be: the term does start a word and does end one. That is the
 * honest reading of "spaces were inserted into a word", and it is the same
 * rule in both directions rather than a heuristic about fragment length.
 *
 * Returning the term rather than a boolean is what lets the sender be told
 * which word tripped the check, which the ticket asks for and which a bare
 * rejection could not support.
 */
export function screen(content: string): Screening {
  const words = normalizeForMatching(content)
    .split(" ")
    .filter((word) => word.length > 0);

  for (const word of words) {
    const term = PROHIBITED.get(word);
    if (term !== undefined) return { refused: true, term };
  }

  // The words run together, plus where each one started and ended in that
  // joined string. A term is a disguise only if it spans from some word's start
  // to some word's end -- see the anchoring note above.
  let joined = "";
  const starts = new Set<number>();
  const ends = new Set<number>();
  for (const word of words) {
    starts.add(joined.length);
    joined += word;
    ends.add(joined.length);
  }

  for (const [normalized, term] of PROHIBITED) {
    let at = joined.indexOf(normalized);
    while (at !== -1) {
      if (starts.has(at) && ends.has(at + normalized.length)) {
        return { refused: true, term };
      }
      at = joined.indexOf(normalized, at + 1);
    }
  }

  // A masked letter -- `sh*t`, `f#ck` -- is the one disguise the passes above
  // cannot see, because the mask stands where a letter should be rather than
  // between two letters. Normalization turned it into a separator, so the word
  // arrives here as pieces that spell the term with a gap in it.
  //
  // Matched against the *masked* form only: the run of words has to be the term
  // with single characters missing at the mask positions, anchored start and
  // end exactly as above. Requiring the surviving letters to line up is what
  // keeps this from being a fuzzy match that starts refusing ordinary words.
  for (const [normalized, term] of PROHIBITED) {
    if (matchesWithMasks(words, normalized)) return { refused: true, term };
  }

  return { refused: false };
}

/**
 * Whether a run of adjacent words spells a term with single letters masked out.
 *
 * The mask characters have already become separators, so `sh*t` arrives as the
 * words `sh` and `t`. Walking the term across those pieces, allowing exactly
 * one skipped letter at each join, is what recognizes it -- and requiring the
 * run to consume the term to its end, having started at its start, is the same
 * anchoring the pass above uses.
 *
 * One skipped letter per gap rather than any number: a mask stands for a
 * single character. Allowing more would make `s...t` match `shit`, which is
 * not a disguise anybody typed -- it is two unrelated words.
 */
function matchesWithMasks(words: readonly string[], normalized: string): boolean {
  for (let start = 0; start < words.length; start += 1) {
    let consumed = 0;
    let masked = false;

    for (let index = start; index < words.length; index += 1) {
      const word = words[index];
      if (word === undefined) break;

      // Each piece has to be the next letters of the term, exactly.
      if (!normalized.startsWith(word, consumed)) break;
      consumed += word.length;

      if (consumed === normalized.length) {
        // Reached the end of the term. Only a run that actually skipped a
        // letter is a mask; an unmasked run was already handled above.
        if (masked && index > start) return true;
        break;
      }

      // The gap to the next piece stands for exactly one masked letter.
      consumed += 1;
      masked = true;
    }
  }

  return false;
}
