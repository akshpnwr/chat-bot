# Hand-rolled profanity normalization instead of a library

Profanity detection uses a small hand-curated wordlist run through our own normalization
pipeline, rather than an npm package such as `bad-words` or `obscenity`.

The task states the goal is "a clear, defensible moderation pipeline rather than a hardcoded
client-side word check". The pipeline is therefore the deliverable, and importing one would hide
the work being assessed. A hand-rolled pipeline is also fully explainable step by step, which a
library's internals are not.

## The pipeline

Normalization, applied in order, server-side, before a Message is accepted:

1. Lowercase
2. Strip diacritics (NFKD normalize, drop combining marks)
3. Map leetspeak: `4/@→a  3→e  1/!/|→i  0→o  $/5→s  7→t  v→u`
4. Replace runs of non-alphanumerics with a single space
5. Collapse repeated characters (`fuuuck` → `fuck`)

Then matching, in three passes against the same normalized text — the first that hits wins:

6. Each whole word, looked up exactly
7. The words run together with the spaces removed, accepted only where a term starts at some
   word's start and ends at some word's end
8. The same run of words allowing exactly one skipped letter at each join

The wordlist is folded through steps 1–5 too, so both sides always agree on how a term is spelled
internally.

### Why replace separators rather than strip them

An earlier draft of this ADR had step 4 *strip* non-alphanumerics outright, and put the collapse
before it. Stripping is what a naive reading of "defeat `f.u.c.k`" suggests, but it destroys every
word boundary in the Message at once: `class assignment` becomes `classassignment`, which contains
a banned term, so the Scunthorpe problem comes back through the front door. Replacing separators
with a space keeps the boundaries and moves the work of recognizing a broken-up word into the
matching passes, where it can be anchored.

The collapse moved after step 4 for the same reason — it must not run across a separator that is
about to become a boundary.

## Consequences

Step 6 is what prevents the Scunthorpe problem: a term appearing *inside* a longer word is not
that word. Steps 7 and 8 are what stop that boundary rule from being trivially bypassed by
inserting a space or a mask, and the start/end anchoring is what keeps them from re-introducing the
problem — `pass the class` joins to `passtheclass`, which contains `ass` but not at any word's
start, so it is not a match.

Both directions are covered by unit tests: bypass attempts (`F.U.C.K`, `fuuuck`, `fvck`, `f u c k`,
`shi t`, `mother fucker`, `sh*t`) must be caught, and false positives (`Scunthorpe`, `assess`,
`classic`, `pass the class`, `shitake`) must not be.

`v→u` is the one letter-for-letter mapping, added because this ADR names `fvck`. It is safe only
because it maps toward a vowel no wordlist term contains, so it cannot fold an innocuous word onto
a banned one. It does make normalization lossy for ordinary prose — `behaved` folds to `behaued` —
which costs nothing, since both sides of every comparison are folded the same way. Note it catches
`fvck` and not `shvt`: a single letter cannot stand for two different vowels at once.

The wordlist lives in its own JSON file so it is obviously swappable for a managed list or
service without touching the pipeline.

Accuracy is bounded by a small curated list. This is a deliberate scope choice: the requirement
is a defensible pipeline resistant to simple bypasses, not exhaustive coverage.
