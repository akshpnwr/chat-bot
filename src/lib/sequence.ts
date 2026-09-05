/**
 * A Message's Sequence as it exists outside the database: a decimal string.
 *
 * ADR-0006 -- the server holds a Sequence as a `bigint` throughout; the string
 * exists only from the serialization boundary outward, because JSON has no
 * integer type and `JSON.stringify` throws on a `bigint`.
 */
export type Sequence = string;

/**
 * The one place a Sequence is compared. Returns the usual negative / zero /
 * positive, so it drops straight into `Array.prototype.sort`.
 *
 * Nothing on the client may compare Sequences with `<` or `Math.max`: `<` on
 * strings is lexicographic ("10" < "9"), and `Math.max` silently rounds past
 * 2^53. Both mistakes are why the comparison lives here rather than at each
 * call site -- #7's reconnect sync depends on this being right in one place.
 */
export function compareSequence(a: Sequence, b: Sequence): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Whether `a` names a strictly later Message than `b`. */
export function isAfter(a: Sequence, b: Sequence): boolean {
  return compareSequence(a, b) > 0;
}

/**
 * The highest Sequence in a list, or null when there is none. Null rather than
 * a zero default, so a caller with no Messages cannot accidentally report
 * holding one -- which is exactly what a Sync Cursor must not claim.
 */
export function maxSequence(sequences: readonly Sequence[]): Sequence | null {
  let highest: Sequence | null = null;
  for (const sequence of sequences) {
    if (highest === null || isAfter(sequence, highest)) {
      highest = sequence;
    }
  }
  return highest;
}
