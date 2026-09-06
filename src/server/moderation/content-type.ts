/**
 * What a file actually is, decided from its bytes rather than from its name or
 * its declared type.
 *
 * The upload route checks the *declared* content type before signing a URL,
 * and that check is worth having -- it refuses the obvious cases without
 * spending any bandwidth. But it is a claim by the uploader: an executable
 * renamed `cat.png` declares `image/png`, and the signed URL then pins that
 * type onto the stored object, so the claim is not merely trusted but
 * recorded. Nothing downstream could tell the difference from metadata alone.
 *
 * So the bytes are inspected at the one place they are in this process's hands
 * anyway: the moderation pipeline reads the object back to classify it. Doing
 * it there costs nothing extra -- no second read, no round trip -- and it puts
 * the answer before the decoder rather than after, so a file that is not an
 * image is refused as what it is rather than surfacing as a decode failure
 * that reads like a broken classifier.
 *
 * A signature check is not a validity check. What this establishes is that the
 * bytes begin the way one of the four accepted formats begins; whether the
 * rest of the file decodes is `decodeToTensor`'s question, and it fails closed
 * too. Two cheap checks in front of one expensive one, each answering a
 * different question.
 */

/** The image types this system will store, as their sniffed names. */
export type SniffedImageType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * A signature, as the run of bytes a file of that format begins with.
 *
 * Held as `(number | null)[]` so a wildcard is expressible: WebP's tag sits
 * after four length bytes whose values are the file's size and therefore
 * arbitrary, and matching them would mean matching one particular file size.
 *
 * Anchored at the start rather than carrying an offset, because all four
 * formats identify themselves there. A format that did not could be given one
 * when it arrives; an offset every signature sets to zero is arithmetic in
 * `matches` for a case that does not exist.
 */
interface Signature {
  type: SniffedImageType;
  bytes: (number | null)[];
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/**
 * The signatures, most specific first.
 *
 * WebP is two runs rather than one because `RIFF` alone is a container prefix
 * shared with WAV and AVI -- a check that stopped at the first four bytes
 * would call a sound file a WebP. The four wildcards between them are the
 * chunk length.
 */
const SIGNATURES: Signature[] = [
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // Both GIF versions, spelled out rather than matched on `GIF` alone: the
  // three-letter prefix is what a crafted file would carry, and the version
  // tag is what a real one does.
  { type: "image/gif", bytes: ascii("GIF87a") },
  { type: "image/gif", bytes: ascii("GIF89a") },
  {
    type: "image/webp",
    bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")],
  },
];

function matches(image: Buffer, signature: Signature): boolean {
  // Checked before indexing rather than relying on `undefined` comparing
  // unequal: a truncated file must be refused for being too short to identify,
  // not accepted because a missing byte happened to satisfy a wildcard.
  if (image.length < signature.bytes.length) return false;

  return signature.bytes.every((expected, index) => {
    if (expected === null) return true;
    return image[index] === expected;
  });
}

/**
 * The image type these bytes actually are, or null for anything else.
 *
 * Null covers three cases that are one refusal here -- an unrecognised format,
 * a file too short to identify, and a format deliberately not accepted such as
 * SVG -- because a sender can do nothing different with any of them. The
 * allowlist shape is inherited from the upload rules on purpose: a format is
 * excluded by not being named, so a new one cannot slip in by not having been
 * thought of.
 */
export function sniffImageType(image: Buffer): SniffedImageType | null {
  for (const signature of SIGNATURES) {
    if (matches(image, signature)) return signature.type;
  }
  return null;
}

/** Whether these bytes are an image this system will deliver. */
export function isSupportedImageContent(image: Buffer): boolean {
  return sniffImageType(image) !== null;
}
