/**
 * What may be uploaded at all, decided before any bytes are stored.
 *
 * These are cheap structural checks -- is this an image, is it a sane size --
 * and they run before the presigned URL is issued rather than after the object
 * lands. A refusal at that point costs nothing; the same refusal afterwards
 * means the bytes already reached the bucket and something has to clean them
 * up. They are not a substitute for classification, which is the expensive
 * check and runs on the content itself.
 *
 * Pure, like the profanity pipeline (ADR-0004) and the nudity rule, so the
 * limits are stated in tests rather than discovered from a 413.
 *
 * Lives here rather than under `src/server/` because both sides need it: the
 * upload route enforces these limits, and the composer applies the same ones
 * to give an instant refusal without a round trip. Server-only modules reach
 * for credentials and Prisma, and this one must be safe in a browser bundle.
 * The client copy is a courtesy -- the server's check is the one that counts.
 */

/**
 * The largest image accepted.
 *
 * Bounded because the classifier decodes the whole image into a tensor in a
 * process with 512 MB (ADR-0001), so an unbounded upload is an unbounded
 * allocation in the one place that cannot afford it.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * The formats accepted, as an allowlist rather than a denylist.
 *
 * SVG is the notable absence. A browser treats it as an image, but it is
 * markup that can carry script, and the classifier cannot rasterize it to look
 * at the content -- so an SVG would be a file that renders in the recipient's
 * page having passed through moderation entirely unexamined. A denylist would
 * have had to think of it; an allowlist excludes it by saying nothing.
 */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/**
 * Whether a declared content type is an image this system will store.
 *
 * Parameters are stripped and case folded, because `IMAGE/JPEG; charset=binary`
 * is the same type as `image/jpeg` and a client is entitled to send either.
 */
export function isAllowedImageType(contentType: string): boolean {
  const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_IMAGE_TYPES.has(essence);
}

/** Why an upload was refused before it began. */
export type UploadRefusal = "UNSUPPORTED_TYPE" | "TOO_LARGE" | "INVALID_LENGTH";

export type UploadValidation = { ok: true } | { ok: false; error: UploadRefusal };

/**
 * Rules on an upload request.
 *
 * The length is checked as well as the type, and it is checked for being a
 * sensible integer rather than merely for being under the cap: a zero, a
 * negative, a fraction or a NaN is a malformed request, and signing a URL for
 * one produces a capability against an object that could never be decoded.
 * The signed URL pins the length too, so this figure is not merely advisory --
 * an upload that exceeds what was declared is rejected by storage itself.
 */
export function validateUploadRequest({
  contentType,
  contentLength,
}: {
  contentType: string;
  contentLength: number;
}): UploadValidation {
  if (!isAllowedImageType(contentType)) {
    return { ok: false, error: "UNSUPPORTED_TYPE" };
  }

  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    return { ok: false, error: "INVALID_LENGTH" };
  }

  if (contentLength > MAX_UPLOAD_BYTES) {
    return { ok: false, error: "TOO_LARGE" };
  }

  return { ok: true };
}
