import { describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  isAllowedImageType,
  validateUploadRequest,
} from "@/server/moderation/upload-rules";

/**
 * What is allowed to be uploaded at all, decided before a byte is stored.
 *
 * These rules run before the presigned URL is issued rather than after the
 * upload lands, which is the point of testing them apart from the rest: a
 * refusal here costs nothing, whereas one after the fact means the bytes
 * already reached the bucket.
 */

describe("isAllowedImageType", () => {
  it("allows the image formats a browser can render", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/gif"]) {
      expect(isAllowedImageType(type)).toBe(true);
    }
  });

  it("refuses anything that is not one of them", () => {
    for (const type of ["application/pdf", "text/html", "video/mp4", "image/svg+xml"]) {
      expect(isAllowedImageType(type)).toBe(false);
    }
  });

  /**
   * SVG is the one exclusion worth naming: it is an image to a browser and a
   * script host to an attacker, and the classifier cannot rasterize it to look
   * at it either.
   */
  it("refuses SVG in particular, which is a script vector rather than a photograph", () => {
    expect(isAllowedImageType("image/svg+xml")).toBe(false);
  });

  it("ignores the parameters a content type may carry", () => {
    expect(isAllowedImageType("image/jpeg; charset=binary")).toBe(true);
  });

  it("is case-insensitive, as content types are", () => {
    expect(isAllowedImageType("IMAGE/PNG")).toBe(true);
  });
});

describe("validateUploadRequest", () => {
  it("accepts an ordinary image", () => {
    const result = validateUploadRequest({
      contentType: "image/jpeg",
      contentLength: 2 * 1024 * 1024,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a type that is not an allowed image", () => {
    const result = validateUploadRequest({
      contentType: "application/pdf",
      contentLength: 1000,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("UNSUPPORTED_TYPE");
  });

  it("refuses a file over the size limit", () => {
    const result = validateUploadRequest({
      contentType: "image/png",
      contentLength: MAX_UPLOAD_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe("TOO_LARGE");
  });

  it("accepts a file exactly at the limit", () => {
    const result = validateUploadRequest({
      contentType: "image/png",
      contentLength: MAX_UPLOAD_BYTES,
    });
    expect(result.ok).toBe(true);
  });

  /**
   * A zero-length or negative length is not a small image, it is a malformed
   * request -- and signing an upload for it would produce a URL for an object
   * the classifier could never decode.
   */
  it("refuses a nonsensical length", () => {
    for (const contentLength of [0, -1, Number.NaN, 1.5]) {
      const result = validateUploadRequest({ contentType: "image/png", contentLength });
      expect(result.ok).toBe(false);
    }
  });
});
