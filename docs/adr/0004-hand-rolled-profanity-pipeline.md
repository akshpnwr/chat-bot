# Hand-rolled profanity normalization instead of a library

Profanity detection uses a small hand-curated wordlist run through our own normalization
pipeline, rather than an npm package such as `bad-words` or `obscenity`.

The task states the goal is "a clear, defensible moderation pipeline rather than a hardcoded
client-side word check". The pipeline is therefore the deliverable, and importing one would hide
the work being assessed. A hand-rolled pipeline is also fully explainable step by step, which a
library's internals are not.

## The pipeline

Applied in order, server-side, before a Message is accepted:

1. Lowercase
2. Strip diacritics (NFKD normalize, drop combining marks)
3. Map leetspeak: `4→a  3→e  1/!→i  0→o  $/5→s  7→t  @→a`
4. Collapse repeated characters (`fuuuck` → `fuck`)
5. Strip non-alphanumerics (defeats `f.u.c.k` and `f u c k`)
6. Match against the wordlist on word boundaries

## Consequences

Step 6's boundary matching is what prevents the Scunthorpe problem — naive substring matching
would reject innocuous words containing a banned substring. Both directions are covered by unit
tests: bypass attempts (`F.U.C.K`, `fuuuck`, `fvck`, `f u c k`) must be caught, and false
positives (`Scunthorpe`, `assess`, `classic`) must not be.

The wordlist lives in its own JSON file so it is obviously swappable for a managed list or
service without touching the pipeline.

Accuracy is bounded by a small curated list. This is a deliberate scope choice: the requirement
is a defensible pipeline resistant to simple bypasses, not exhaustive coverage.
