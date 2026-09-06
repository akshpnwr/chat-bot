"use client";

import { MAX_UPLOAD_BYTES, isAllowedImageType } from "@/lib/upload-rules";

/**
 * Getting an image from the sender's disk into quarantine.
 *
 * The bytes go from the browser straight to object storage. This module is
 * what arranges that: it asks the server for a presigned PUT, uploads to it,
 * and hands back only the key -- so the application server, which holds a
 * 121 MB classifier inside 512 MB (ADR-0001, ADR-0007), never has an image in
 * its memory on the way in.
 *
 * The checks here mirror the server's rather than replacing them. The server
 * refuses the same type and the same size when it signs the URL, and it is the
 * one that counts; doing it here as well means a sender who picks a PDF is
 * told so instantly rather than after a round trip, which is a courtesy rather
 * than a control.
 */

/** Why an image could not be attached, in words the sender can act on. */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

/**
 * The image's intrinsic size, measured before it is uploaded.
 *
 * Measured in the browser because this is the only place the dimensions are
 * known cheaply -- the server would have to decode the image to learn them,
 * and it does that only during classification, which is after the bubble needs
 * to reserve its space. Reserving that space from these numbers is what stops
 * the thread reflowing when the image finally loads.
 */
export async function measureImage(
  file: File,
): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise<{ width: number; height: number }>(
      (resolve, reject) => {
        const image = new Image();
        image.onload = () =>
          resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () =>
          reject(new ImageRejectedError("That file could not be read as an image."));
        image.src = url;
      },
    );

    if (size.width <= 0 || size.height <= 0) {
      throw new ImageRejectedError("That file could not be read as an image.");
    }
    return size;
  } finally {
    // Released as soon as it is measured. This URL is not the one the bubble
    // renders from -- that one is created separately and lives as long as the
    // entry does -- so holding this one would pin the file in memory for
    // nothing.
    URL.revokeObjectURL(url);
  }
}

/**
 * Checks what can be checked before any bytes move.
 *
 * Both refusals are worth catching early for the same reason: they are certain.
 * An unsupported type and an oversized file will be refused by the server
 * whatever happens, so uploading first would spend the sender's bandwidth to
 * reach a conclusion already available.
 */
export function refuseUnsendableImage(file: File): void {
  if (!isAllowedImageType(file.type)) {
    throw new ImageRejectedError("Only JPEG, PNG, WebP and GIF images can be sent.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const megabytes = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
    throw new ImageRejectedError(`Images must be smaller than ${megabytes} MB.`);
  }
  if (file.size <= 0) {
    throw new ImageRejectedError("That file is empty.");
  }
}

/**
 * How long a refused upload says to wait, in whole seconds, or null.
 *
 * Read from the standard `Retry-After` header rather than from the body, so
 * this keeps working if an intermediary answers with a bare 429 of its own.
 * Null when there is no usable figure -- the caller then says "a moment"
 * rather than printing a NaN at the sender.
 */
function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

/**
 * Uploads one image to quarantine and returns the key it landed under.
 *
 * Two requests, and the split is the whole point: the first asks this
 * application for permission and gets back a URL, and the second carries the
 * bytes to storage without touching this application at all.
 *
 * The key is what comes back rather than a URL, because a key is not a
 * capability -- the bucket is private, and reading the object later goes
 * through an authorized route (see `/api/messages/[messageId]/asset`).
 */
export async function uploadToQuarantine(
  conversationId: string,
  file: File,
): Promise<string> {
  const presign = await fetch(`/api/conversations/${conversationId}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
  });

  if (!presign.ok) {
    // A rate limit is told apart from every other refusal, because it is the
    // only one where "try again" is wrong advice: trying again immediately is
    // the behaviour the limit exists to stop. The sender is told to wait, and
    // for roughly how long, so they back off rather than hammer.
    if (presign.status === 429) {
      const seconds = retryAfterSeconds(presign);
      throw new ImageRejectedError(
        seconds === null
          ? "Too many uploads. Please wait a moment before sending another image."
          : `Too many uploads. Please wait ${seconds} seconds before sending another image.`,
      );
    }

    // The server's refusal reasons are the same ones checked above, so reaching
    // here means either a race with a changed rule or a genuine fault. Either
    // way the sender gets one sentence rather than a status code.
    throw new ImageRejectedError("That image could not be uploaded. Try again.");
  }

  const { url, key } = (await presign.json()) as { url: string; key: string };

  const upload = await fetch(url, {
    method: "PUT",
    // The type must match what was signed, or storage refuses the object.
    headers: { "Content-Type": file.type },
    body: file,
  });

  if (!upload.ok) {
    throw new ImageRejectedError("That image could not be uploaded. Try again.");
  }

  return key;
}
