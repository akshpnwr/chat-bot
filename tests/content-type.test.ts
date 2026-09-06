import { describe, expect, it } from "vitest";
import { sniffImageType, isSupportedImageContent } from "@/server/moderation/content-type";

/**
 * A file's declared type is a claim by whoever uploaded it; these tests are
 * about the bytes disagreeing with the claim. The fixtures are the real magic
 * numbers rather than whole images -- what is under test is the signature
 * check, and a decoder's opinion of the rest of the file is a separate
 * question answered by `decodeToTensor`.
 */

/** The leading bytes of each format, padded so a truncation test is distinct. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const GIF = Buffer.from([...Buffer.from("GIF89a", "ascii"), 0x10, 0x00, 0x10, 0x00]);

/** RIFF....WEBP -- the four size bytes between the two tags are ignored. */
const WEBP = Buffer.from([
  ...Buffer.from("RIFF", "ascii"),
  0x24,
  0x00,
  0x00,
  0x00,
  ...Buffer.from("WEBPVP8 ", "ascii"),
]);

describe("sniffImageType", () => {
  it("recognises a JPEG", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
  });

  it("recognises a PNG", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
  });

  it("recognises a GIF", () => {
    expect(sniffImageType(GIF)).toBe("image/gif");
  });

  it("recognises a WebP", () => {
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("recognises GIF87a as well as GIF89a", () => {
    const gif87 = Buffer.from([...Buffer.from("GIF87a", "ascii"), 0x10, 0x00]);
    expect(sniffImageType(gif87)).toBe("image/gif");
  });

  it("returns null for something that is not an image", () => {
    expect(sniffImageType(Buffer.from("%PDF-1.7\n%hello", "ascii"))).toBeNull();
  });

  /**
   * The case the acceptance criterion names. An executable renamed `cat.png`
   * declares `image/png` at the upload route and is signed for as one, so the
   * declared type cannot be what decides this.
   */
  it("returns null for a renamed executable", () => {
    expect(sniffImageType(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]))).toBeNull();
  });

  /**
   * SVG is the deliberate absence. It is markup a browser will render and
   * script, and it has no binary signature to match -- so it fails here by
   * saying nothing, which is the same way the upload allowlist excludes it.
   */
  it("returns null for an SVG", () => {
    expect(sniffImageType(Buffer.from("<svg xmlns='...'><script/></svg>", "utf8"))).toBeNull();
  });

  it("returns null for a buffer too short to hold any signature", () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  /**
   * A RIFF container that is not WebP -- a WAV, say -- shares its first four
   * bytes with one. Matching on the prefix alone would admit it.
   */
  it("returns null for a RIFF container that is not WebP", () => {
    const wav = Buffer.from([
      ...Buffer.from("RIFF", "ascii"),
      0x24,
      0x00,
      0x00,
      0x00,
      ...Buffer.from("WAVEfmt ", "ascii"),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe("isSupportedImageContent", () => {
  it("accepts bytes whose signature is an allowed image", () => {
    expect(isSupportedImageContent(PNG)).toBe(true);
  });

  it("refuses bytes whose signature is not", () => {
    expect(isSupportedImageContent(Buffer.from("not an image at all", "utf8"))).toBe(false);
  });
});
