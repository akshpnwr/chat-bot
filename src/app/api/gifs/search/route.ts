import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { gifProvider } from "@/server/gifs/provider";
import { GifSearchUnavailableError } from "@/server/gifs/tenor";

/**
 * Searches the GIF provider on the browser's behalf.
 *
 * The proxy exists for one reason: the provider's key must not reach the
 * client. A browser calling Tenor directly would have to carry the credential
 * to do it, and a credential in a client bundle is a credential anyone can
 * read and spend. So the search is made from the server, and what comes back
 * has been rebuilt field by field in the adapter rather than forwarded.
 *
 * Requiring a session is not about protecting the provider's index -- GIFs are
 * public -- but about not offering an unauthenticated proxy that spends this
 * application's rate limit for whoever finds the URL.
 */

/** How many results one search returns. A grid's worth, not a catalogue. */
const RESULT_LIMIT = 24;

/**
 * The longest query passed on. Long enough for a phrase, short enough that a
 * caller cannot use this endpoint to push arbitrary volume at the provider.
 */
const MAX_QUERY_LENGTH = 100;

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const provider = gifProvider();
  if (!provider.configured) {
    // A checkout with no `GIFS_API_KEY` is a supported state rather than a
    // fault -- stickers need no credential, so the application still works and
    // the GIF tab simply reports itself unavailable. 503 rather than 500: it
    // is a capability this deployment does not have, not something that broke.
    return NextResponse.json({ error: "GIF_SEARCH_UNAVAILABLE" }, { status: 503 });
  }

  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (query.length === 0) {
    return NextResponse.json({ results: [] });
  }

  try {
    const results = await provider.search(query.slice(0, MAX_QUERY_LENGTH), RESULT_LIMIT);
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof GifSearchUnavailableError) {
      // The adapter has already logged what actually went wrong. The provider's
      // status is not repeated here: a browser can do nothing different with a
      // 429 than with a 500, and the rate-limit state is not the client's to
      // know.
      return NextResponse.json({ error: "GIF_SEARCH_UNAVAILABLE" }, { status: 503 });
    }
    console.error("[api] gif search failed", error);
    return NextResponse.json({ error: "INTERNAL" }, { status: 500 });
  }
}
