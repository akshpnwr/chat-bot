import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NotAParticipantError } from "@/server/authorization";
import { readableAsset } from "@/server/messages";
import { presignDownload } from "@/server/storage";

/**
 * Redirects to a short-lived URL for one Message's image.
 *
 * The bucket is private, so an image is never a durable link. A reader asks
 * this route each time they need the bytes, is authorized against the read
 * model (see `readableAsset`), and is redirected to a presigned GET that stops
 * working shortly afterwards. An image URL that escapes a Conversation --
 * pasted into a chat elsewhere, captured from a network tab -- therefore
 * expires rather than becoming a permanent public copy.
 *
 * A redirect rather than a proxy, for the same reason the upload is presigned:
 * the bytes must not pass through this process. Proxying every image view
 * through a 512 MB single-node server (ADR-0001) would put every concurrent
 * reader's download in the same memory as the classifier.
 *
 * The redirect is explicitly uncacheable. Without that, a shared cache could
 * hold the 307 and serve the presigned URL to a second reader who was never
 * authorized -- which would make this route's check a formality.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { messageId } = await params;

  try {
    const key = await readableAsset({ userId: session.user.id, messageId });
    const url = await presignDownload(key);

    return NextResponse.redirect(url, {
      status: 307,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    // One answer for every refusal -- a Message that does not exist, one in
    // somebody else's Conversation, and one moderation rejected are alike from
    // here. Distinguishing them would report which images were refused.
    if (error instanceof NotAParticipantError) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    console.error("[api] presigning an image download failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
