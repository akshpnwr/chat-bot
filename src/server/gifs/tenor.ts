/**
 * The GIF provider, and the only place its key exists.
 *
 * Every request to Tenor is made from here, inside the server process. The
 * browser never talks to the provider: it asks this application, which asks the
 * provider and hands back results with the credential stripped out. That is the
 * whole reason the search is proxied rather than called from the client, and it
 * is why results are rebuilt field by field below rather than forwarded -- a
 * passthrough would eventually carry something the provider chose to include.
 *
 * `fetch` is injected rather than reached for, so the adapter is testable
 * without a network and without a key. The rest of the application takes the
 * provider through `gifProvider()` in ./provider.ts, which builds one.
 */

import type { WireGif } from "@/lib/wire";

/** Raised when the provider could not be asked, or would not answer. */
export class GifSearchUnavailableError extends Error {
  readonly code = "GIF_SEARCH_UNAVAILABLE";

  constructor(message = "GIF search is unavailable.") {
    super(message);
    this.name = "GifSearchUnavailableError";
  }
}

/**
 * A search result, in the only shape that reaches the browser.
 *
 * The shape itself lives in `src/lib/wire.ts` with the other wire types, since
 * the picker needs it and must not import this module -- this is where the
 * provider's key is. Aliased rather than re-declared so the two cannot drift.
 */
export type GifResult = WireGif;

/** The media a resolved id actually points at, as stored on a Message. */
export interface ResolvedGif {
  url: string;
  width: number;
  height: number;
  description: string;
}

export interface GifProviderConfig {
  /** Absent in a checkout with no credential, which is a supported state. */
  apiKey: string | undefined;
}

export interface GifProvider {
  /** False when no key is configured; the picker says so rather than erroring. */
  readonly configured: boolean;
  search: (query: string, limit: number) => Promise<GifResult[]>;
  /**
   * The media the provider holds for one id, or null if it holds none.
   *
   * This is the security seam of the whole GIF path. A client names an id and
   * never a URL, and what is stored on the Message is what the provider
   * returns for that id -- so a GIF Message can only ever point at something
   * the provider indexed. Accepting a URL from the client instead would make
   * the GIF path a way to deliver an arbitrary image having skipped
   * classification entirely (ADR-0003), which is precisely the bypass the
   * quarantine/promote split exists to prevent for uploads.
   */
  resolve: (id: string) => Promise<ResolvedGif | null>;
}

const TENOR_BASE = "https://tenor.googleapis.com/v2";

/**
 * A caller identifier Tenor asks for so it can attribute traffic. It is not a
 * credential and is safe in a URL.
 */
const CLIENT_KEY = "chat-bot";

/**
 * The formats asked for, narrowed to the two that are rendered.
 *
 * Requesting only these keeps the response small -- Tenor returns a dozen
 * transcodes per result otherwise, most of them video formats this application
 * has no use for.
 */
const MEDIA_FILTER = "tinygif,gif";

/**
 * What a provider id may look like.
 *
 * The check is deliberately a shape rather than a format: the id is
 * interpolated into a query string, so an id containing separators would let a
 * caller append parameters of their own to a request this server makes with
 * its key attached.
 */
const GIF_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** One media format as Tenor returns it, before anything is trusted about it. */
interface TenorFormat {
  url?: unknown;
  dims?: unknown;
}

interface TenorResult {
  id?: unknown;
  content_description?: unknown;
  media_formats?: Record<string, TenorFormat> | undefined;
}

function asFormat(formats: Record<string, TenorFormat> | undefined, name: string) {
  const format = formats?.[name];
  const url = typeof format?.url === "string" ? format.url : null;
  const dims = Array.isArray(format?.dims) ? format.dims : null;
  const width = typeof dims?.[0] === "number" ? dims[0] : null;
  const height = typeof dims?.[1] === "number" ? dims[1] : null;
  if (url === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { url, width, height };
}

/**
 * Turns one provider result into ours, or null if it is unusable.
 *
 * Every field is read defensively. This is a third party's response shape and
 * it is not this application's to guarantee -- a result missing the format the
 * picker renders is dropped rather than passed on as a hole in the grid.
 */
function toResult(raw: TenorResult): GifResult | null {
  const id = typeof raw.id === "string" ? raw.id : null;
  if (id === null || !GIF_ID_PATTERN.test(id)) return null;

  const preview = asFormat(raw.media_formats, "tinygif");
  const full = asFormat(raw.media_formats, "gif");
  if (!preview || !full) return null;

  return {
    id,
    description:
      typeof raw.content_description === "string" ? raw.content_description : "GIF",
    previewUrl: preview.url,
    fullUrl: full.url,
    // The full GIF's dimensions, because the full GIF is what the bubble will
    // hold -- reserving the preview's space would resize when it loaded.
    width: full.width,
    height: full.height,
  };
}

/** The injected `fetch`, narrowed to what this module uses. */
export type Fetcher = (url: string) => Promise<Response>;

export function createGifProvider(
  config: GifProviderConfig,
  fetcher: Fetcher,
): GifProvider {
  const { apiKey } = config;
  const configured = typeof apiKey === "string" && apiKey.length > 0;

  /** Asks the provider and returns its results, already narrowed to ours. */
  async function ask(
    path: string,
    params: Record<string, string>,
  ): Promise<GifResult[]> {
    if (!configured) throw new GifSearchUnavailableError();

    const query = new URLSearchParams({
      ...params,
      key: apiKey,
      client_key: CLIENT_KEY,
      media_filter: MEDIA_FILTER,
    });

    let response: Response;
    try {
      response = await fetcher(`${TENOR_BASE}/${path}?${query.toString()}`);
    } catch (error) {
      // The provider being unreachable is an ordinary outcome for a third
      // party, so it is reported as unavailability rather than propagated as
      // whatever the network happened to throw.
      console.error("[gifs] reaching the provider failed", error);
      throw new GifSearchUnavailableError();
    }

    if (!response.ok) {
      // The status is logged but not surfaced: a caller can do nothing
      // different with a 429 than with a 500, and the provider's rate-limit
      // state is not something to tell a browser about.
      console.error(`[gifs] provider answered ${response.status}`);
      throw new GifSearchUnavailableError();
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GifSearchUnavailableError();
    }

    const results = (body as { results?: unknown })?.results;
    if (!Array.isArray(results)) throw new GifSearchUnavailableError();

    return results
      .map((raw) => toResult(raw as TenorResult))
      .filter((result): result is GifResult => result !== null);
  }

  return {
    configured,

    async search(query, limit) {
      return ask("search", {
        q: query,
        limit: String(limit),
        // Tenor's own filter, asked for at its strictest. It is not a
        // substitute for this application's moderation -- it is the provider's
        // rating of its own index -- but a GIF skips classification, so
        // requesting the narrowest index is worth doing where it costs nothing.
        contentfilter: "high",
      });
    },

    async resolve(id) {
      // Checked before any request, so a malformed id cannot become extra
      // query parameters on a call this server makes with its key attached.
      if (!GIF_ID_PATTERN.test(id)) return null;
      if (!configured) return null;

      let results: GifResult[];
      try {
        results = await ask("posts", { ids: id });
      } catch {
        // A resolve failure is a refusal to attach rather than an error to
        // report: the caller's only move either way is to not store the GIF.
        return null;
      }

      // Matched back to the id that was asked for. The provider answering with
      // something else -- or an id that widened into several results -- must
      // not end up attached to a Message.
      const found = results.find((result) => result.id === id);
      if (!found) return null;

      return {
        url: found.fullUrl,
        width: found.width,
        height: found.height,
        description: found.description,
      };
    },
  };
}
