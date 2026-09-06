import { randomUUID } from "node:crypto";
import {
  CopyObjectCommand,
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

  // Server-side: the bucket copies the object itself and the bytes never
  // enter this process. Reading them in to write them back would put an
  // 8 MB image in a 512 MB process (ADR-0001) that already holds the 121 MB
  // classifier -- the same cost the presigned upload above exists to avoid,
  // paid on the way out instead of the way in.
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: destination,
      CopySource: `${bucket}/${key}`,
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

/**
 * Whether a key a client named is one it may attach to a Message.
 *
 * A client tells the server which object to attach, and that string cannot be
 * taken at face value. Two things are checked, and each closes a different
 * hole:
 *
 *  - It must sit under the quarantine prefix. A caller naming an
 *    `attachments/` key would be attaching an object that is already promoted,
 *    which is to say one that skips classification entirely -- the exact
 *    bypass the quarantine/promote split exists to make impossible.
 *  - The rest must be a bare UUID, as `quarantineKey` generates. Anything else
 *    is either a traversal attempt (`quarantine/../attachments/x`) or a key
 *    this server never issued.
 *
 * What this cannot check is *whose* upload it was: the presigned URL is issued
 * without recording who asked for it. That is acceptable because the key is a
 * random v4 UUID handed back over an authenticated response -- guessing one is
 * not a realistic attack, and the worst an attacker who somehow held another
 * user's key could do is attach an image to their own Conversation, where it
 * is classified like any other.
 */
const QUARANTINE_KEY_PATTERN = new RegExp(
  `^${QUARANTINE_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
);

export function isAttachableKey(key: string): boolean {
  return QUARANTINE_KEY_PATTERN.test(key);
}
