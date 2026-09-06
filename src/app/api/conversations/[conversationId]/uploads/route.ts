import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { assertParticipant, NotAParticipantError } from "@/server/authorization";
import { validateUploadRequest } from "@/lib/upload-rules";
import { presignUpload } from "@/server/storage";
import { createRateLimiter, RATE_LIMITS } from "@/lib/rate-limit";

/**
 * What one account may upload, held at module scope so it outlives a request.
 *
 * A limiter built per request would count to one and forget, which is to say
 * it would not be a limiter at all. Module scope is what gives it the lifetime
 * of the process -- the same lifetime presence and typing have, and for the
 * same reason (ADR-0001).
 *
 * This is the tightest of the three limits because an upload is the most
 * expensive thing an authenticated caller can ask for: each one buys them an
 * object in the bucket and an inference on the WASM backend (ADR-0007) inside
 * a 512 MB process.
 */
const uploadLimiter = createRateLimiter(RATE_LIMITS.upload);

/**
 * Issues the capability to upload one image, straight to object storage.
 *
 * The bytes deliberately do not come through here. The ticket asks that large
 * files not pass through the application server, and this is how: the browser
 * is handed a presigned PUT and talks to the bucket directly, so an 8 MB
 * upload never occupies a request handler in the 512 MB process (ADR-0001)
 * that also holds a 121 MB classifier.
 *
 * What this route does instead is decide *whether* an upload may happen, and
 * under exactly what terms. Three things are settled before a URL exists:
 *
 *  - Who is asking. The session is verified server-side and membership of the
 *    Conversation is checked, so a signed-in stranger cannot obtain write
 *    access to the bucket by naming somebody else's Conversation.
 *  - What may be stored. The content type and length are checked against the
 *    upload rules, and both are *signed into* the URL -- so the object cannot
 *    land as a type that was never allowed, and an upload larger than declared
 *    is refused by storage itself rather than discovered afterwards.
 *  - Where it lands. The key is generated here, under the quarantine prefix,
 *    and never taken from the client. A client-chosen key is a path-traversal
 *    question; worse, it would let a caller write directly into
 *    `attachments/` and skip classification entirely.
 *
 * The key comes back to the client so it can name the object when it sends the
 * Message. That is not a capability -- the bucket is private, the key is a
 * random UUID, and the socket re-derives everything it needs from the sender's
 * own connection.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  /**
   * Keyed on the session's user id rather than on the address the request came
   * from. Behind the deployment's proxy every request shares one address, so an
   * address-keyed limit would refuse everybody the moment one account flooded --
   * and the forwarded-for header that would distinguish them is written by the
   * client. Checked after the session for exactly that reason: the key does not
   * exist until the caller is identified.
   */
  const decision = uploadLimiter.consume(session.user.id);
  if (!decision.allowed) {
    const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
    return NextResponse.json(
      { error: "RATE_LIMITED", retryAfterMs: decision.retryAfterMs },
      {
        status: 429,
        // The standard header as well as the body, so an intermediary or a
        // client library that already understands backing off does not have to
        // be taught this application's JSON to do it.
        headers: { "Retry-After": String(retryAfterSeconds) },
      },
    );
  }

  const { conversationId } = await params;

  let body: { contentType?: unknown; contentLength?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // Released for the same reason as a failed validation below: nothing was
    // signed, so nothing was spent. Named by its own handle, so a concurrent
    // request from the same user keeps the slot it consumed.
    uploadLimiter.release(session.user.id, decision.attempt);
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  // Parsed rather than trusted. Both fields cross the wire from a client, and
  // a non-string type or a non-numeric length would otherwise be signed into a
  // URL as whatever it happened to be.
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const contentLength =
    typeof body.contentLength === "number" ? body.contentLength : Number.NaN;

  const validation = validateUploadRequest({ contentType, contentLength });
  if (!validation.ok) {
    // Released, because a malformed request cost nothing worth rationing --
    // no URL was signed and no object can land. Counting it would let a client
    // spend a sender's whole allowance on requests that were never going to
    // store anything.
    uploadLimiter.release(session.user.id, decision.attempt);
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    // Membership before the URL, so a non-Participant never receives one.
    await assertParticipant(session.user.id, conversationId);

    const { url, key } = await presignUpload({ contentType, contentLength });
    return NextResponse.json({ url, key });
  } catch (error) {
    // Identical whether the Conversation does not exist or the caller simply
    // is not a member, so the response does not leak which Conversations exist.
    if (error instanceof NotAParticipantError) {
      return NextResponse.json({ error: "NOT_A_PARTICIPANT" }, { status: 403 });
    }
    console.error("[api] presigning an upload failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
