import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage for image attachments.
 *
 * The ticket asks that large files not go through the application server, and
 * presigned URLs are how that is arranged: the browser is handed a URL it may
 * PUT to directly, so a 5 MB upload never occupies a request handler on a
 * 512 MB single-node process (ADR-0001). Streaming uploads through the app
 * would put every concurrent upload's bytes in that process's memory, next to
 * the 121 MB the classifier already holds.
 *
 * The bucket is private. Nothing here is publicly readable, and a reader is
 * given a short-lived presigned GET rather than a durable link -- so an image
 * URL that leaks out of a Conversation stops working, and the read model stays
 * the thing that decides who sees what (ADR-0003).
 */

/**
 * Where an object sits in its lifecycle, expressed as a key prefix.
 *
 * Quarantine is not a formality. An upload lands there before it has been
 * classified, and it is promoted to `attachments/` only once it has passed --
 * so the set of objects a delivered Message can point at is exactly the set
 * that cleared moderation, rather than a subset distinguished only by a
 * database column somebody might forget to filter on.
 */
export const QUARANTINE_PREFIX = "quarantine/";
export const ATTACHMENT_PREFIX = "attachments/";

/**
 * How long a presigned upload URL is good for.
 *
 * Long enough for a slow connection to finish a large image, short enough that
 * a URL captured from the network tab is not a lasting write capability
 * against the bucket.
 */
const UPLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * How long a presigned download URL is good for.
 *
 * Deliberately short-lived, and deliberately not the whole story: the reader
 * fetches a fresh one through an authorized route each time they open the
 * Conversation, so expiry costs them nothing while a leaked URL stops working
 * quickly.
 */
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let cached: { client: S3Client; bucket: string } | null = null;

/**
 * The S3 client, built on first use rather than at module load.
 *
 * At module load it would demand credentials of anything that so much as
 * imports this file -- including the unit tests for the pieces around it,
 * which never touch storage. Deferring means the configuration is required by
 * the code paths that actually upload.
 */
function storage(): { client: S3Client; bucket: string } {
  if (cached === null) {
    cached = {
      client: new S3Client({
        region: process.env.STORAGE_REGION ?? "us-east-2",
        endpoint: requireEnv("STORAGE_ENDPOINT"),
        // Neon's S3 endpoint addresses buckets by path rather than by
        // subdomain, which is also what most S3-compatible services want.
        forcePathStyle: true,
        credentials: {
          accessKeyId: requireEnv("STORAGE_ACCESS_KEY_ID"),
          secretAccessKey: requireEnv("STORAGE_SECRET_ACCESS_KEY"),
        },
      }),
      bucket: requireEnv("STORAGE_BUCKET"),
    };
  }
  return cached;
}

/**
 * The key an upload is given, under the quarantine prefix.
 *
 * A random UUID rather than anything derived from the file's name or the
 * sender. A name chosen by the client is a path-traversal question and a
 * collision question at once; a name derived from the sender or Conversation
 * makes the key itself a small disclosure. Random says nothing and collides
 * with nothing.
 */
export function quarantineKey(): string {
  return `${QUARANTINE_PREFIX}${randomUUID()}`;
}

/** The key a quarantined object takes once it has cleared moderation. */
export function promotedKey(key: string): string {
  return key.startsWith(QUARANTINE_PREFIX)
    ? `${ATTACHMENT_PREFIX}${key.slice(QUARANTINE_PREFIX.length)}`
    : key;
}

/**
 * A URL the browser may PUT the image to, and the key it will land under.
 *
 * The content type is signed into the URL rather than left to the client, so
 * the object cannot be stored as something other than what was declared and
 * checked.
 */
export async function presignUpload({
  contentType,
  contentLength,
}: {
  contentType: string;
  contentLength: number;
}): Promise<{ url: string; key: string }> {
  const { client, bucket } = storage();
  const key = quarantineKey();

  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return { url, key };
}

/** A short-lived URL to read an object, handed out only after authorization. */
export function presignDownload(key: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
}

/** Reads an object back into memory, for classification. */
export async function readObject(key: string): Promise<Buffer> {
  const { client, bucket } = storage();
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) throw new Error(`Object has no body: ${key}`);
  return Buffer.from(await response.Body.transformToByteArray());
}

/**
 * Moves a cleared object out of quarantine.
 *
 * Copy-then-delete rather than a rename, because S3 has no rename. The delete
 * is allowed to fail without failing the promotion: by the time it runs the
 * copy has succeeded, so the image is deliverable, and a leftover quarantine
 * object is litter rather than a correctness problem -- whereas failing here
 * would reject an image that had already passed.
 */
export async function promote(key: string): Promise<string> {
  const { client, bucket } = storage();
  const destination = promotedKey(key);

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: destination,
      Body: await readObject(key),
    }),
  );

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    console.error("[storage] removing the quarantined copy failed", error);
  }

  return destination;
}

/**
 * Deletes an object outright -- what a refused image gets.
 *
 * A refused image is removed rather than left in quarantine. Keeping it would
 * mean the system holds a copy of exactly the content it just decided must not
 * be delivered, which is a liability rather than an audit trail.
 */
export async function discard(key: string): Promise<void> {
  const { client, bucket } = storage();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
