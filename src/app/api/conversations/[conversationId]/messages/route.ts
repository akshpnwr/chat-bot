import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { NotAParticipantError } from "@/server/authorization";
import { readMessages } from "@/server/messages";
import { toWireMessage, type WireMessagePage } from "@/lib/wire";

/** Bounded so a caller cannot ask for an unbounded page and stall the server. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * A page of a Conversation's history, newest Message first.
 *
 * Live Messages arrive over the socket; this route serves the reader walking
 * backwards through history, which is a request/response shape rather than a
 * push. Splitting them that way means the scroll-up path is plain HTTP and can
 * be retried, cached and debugged like any other fetch.
 *
 * The `before` cursor is a Sequence, so it arrives as a decimal string
 * (ADR-0006) and is parsed back to a bigint here -- the read model works on the
 * real integer type.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { conversationId } = await params;
  const url = new URL(request.url);

  const limitParam = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const beforeParam = url.searchParams.get("before");
  let before: bigint | undefined;
  if (beforeParam !== null) {
    try {
      before = BigInt(beforeParam);
    } catch {
      return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400 });
    }
  }

  try {
    const page = await readMessages({
      userId: session.user.id,
      conversationId,
      limit,
      before,
    });

    const body: WireMessagePage = {
      messages: page.messages.map(toWireMessage),
      nextCursor: page.nextCursor === null ? null : page.nextCursor.toString(),
    };
    return NextResponse.json(body);
  } catch (error) {
    // Identical whether the Conversation does not exist or the user simply is
    // not a member, so the response does not leak which Conversations exist.
    if (error instanceof NotAParticipantError) {
      return NextResponse.json({ error: "NOT_A_PARTICIPANT" }, { status: 403 });
    }
    console.error("[api] reading messages failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
