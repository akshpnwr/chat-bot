import { describe, expect, it } from "vitest";
import {
  createGifProvider,
  GifSearchUnavailableError,
  type GifProviderConfig,
} from "@/server/gifs/tenor";

/**
 * The GIF provider adapter, tested with `fetch` injected.
 *
 * No network call is made here, and that is deliberate rather than merely
 * convenient: the provider's index is its business, and a test that asserted
 * what a search for "cat" returns would fail when Tenor reranks. What belongs
 * to this project is the shape of the request it builds, that the key stays on
 * the server, and how it behaves when the provider misbehaves -- which is what
 * these exercise.
 */

const CONFIG: GifProviderConfig = { apiKey: "secret-provider-key" };

/** One Tenor result, in the shape their v2 API actually returns. */
function tenorResult(id: string) {
  return {
    id,
    content_description: `a ${id} gif`,
    media_formats: {
      tinygif: { url: `https://media.tenor.com/${id}/preview.gif`, dims: [220, 160] },
      gif: { url: `https://media.tenor.com/${id}/full.gif`, dims: [498, 362] },
    },
  };
}

/** A fetch that answers with one canned body and records what it was asked. */
function stubFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    calls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

describe("searchGifs", () => {
  it("returns results a picker can render", async () => {
    const { fetcher } = stubFetch({ results: [tenorResult("abc"), tenorResult("def")] });
    const provider = createGifProvider(CONFIG, fetcher);

    const results = await provider.search("dancing", 20);

    expect(results.map((result) => result.id)).toEqual(["abc", "def"]);
    expect(results[0]!.previewUrl).toBe("https://media.tenor.com/abc/preview.gif");
    expect(results[0]!.width).toBe(498);
    expect(results[0]!.height).toBe(362);
    expect(results[0]!.description).toBe("a abc gif");
  });

  /**
   * The acceptance criterion, pinned at the layer that holds the key. A result
   * is built field by field from the provider's response rather than passed
   * through, so there is nothing for the key to ride out on -- and the search
   * URL, which does carry it, never leaves this module.
   */
  it("never puts the provider key in a result", async () => {
    const { fetcher } = stubFetch({ results: [tenorResult("abc")] });
    const provider = createGifProvider(CONFIG, fetcher);

    const results = await provider.search("dancing", 20);

    expect(JSON.stringify(results)).not.toContain("secret-provider-key");
  });

  it("sends the key to the provider, not to the caller", async () => {
    const { fetcher, calls } = stubFetch({ results: [] });
    const provider = createGifProvider(CONFIG, fetcher);

    await provider.search("dancing", 20);

    expect(calls[0]).toContain("key=secret-provider-key");
    expect(calls[0]).toContain("q=dancing");
  });

  it("passes a query through unescaped characters and all", async () => {
    const { fetcher, calls } = stubFetch({ results: [] });
    const provider = createGifProvider(CONFIG, fetcher);

    await provider.search("cats & dogs", 20);

    expect(calls[0]).toContain("q=cats+%26+dogs");
  });

  /**
   * A result missing the format we render is dropped rather than returned with
   * a null url. The picker would have nothing to draw for it, and a hole in a
   * grid is a worse answer than a shorter grid.
   */
  it("drops results that carry no usable media", async () => {
    const { fetcher } = stubFetch({
      results: [{ id: "broken", content_description: "x", media_formats: {} }, tenorResult("ok")],
    });
    const provider = createGifProvider(CONFIG, fetcher);

    const results = await provider.search("dancing", 20);

    expect(results.map((result) => result.id)).toEqual(["ok"]);
  });

  it("reports the provider being down rather than throwing something opaque", async () => {
    const { fetcher } = stubFetch({ error: "rate limited" }, 429);
    const provider = createGifProvider(CONFIG, fetcher);

    await expect(provider.search("dancing", 20)).rejects.toBeInstanceOf(
      GifSearchUnavailableError,
    );
  });

  it("treats a malformed body as the provider being unavailable", async () => {
    const provider = createGifProvider(CONFIG, async () => new Response("not json"));

    await expect(provider.search("dancing", 20)).rejects.toBeInstanceOf(
      GifSearchUnavailableError,
    );
  });
});

describe("resolveGif", () => {
  /**
   * This is the security seam. A client names an id, never a URL, and the URL
   * that is stored on the Message is the one the provider itself returns for
   * that id -- so a GIF Message can only ever point at something the provider
   * indexed. That is what stops the GIF path becoming a way to deliver an
   * arbitrary image without classification.
   */
  it("resolves an id to the media the provider holds for it", async () => {
    const { fetcher, calls } = stubFetch({ results: [tenorResult("abc")] });
    const provider = createGifProvider(CONFIG, fetcher);

    const gif = await provider.resolve("abc");

    expect(gif).not.toBeNull();
    expect(gif!.url).toBe("https://media.tenor.com/abc/full.gif");
    expect(gif!.width).toBe(498);
    expect(gif!.height).toBe(362);
    expect(calls[0]).toContain("ids=abc");
  });

  it("refuses an id the provider does not know", async () => {
    const { fetcher } = stubFetch({ results: [] });
    const provider = createGifProvider(CONFIG, fetcher);

    expect(await provider.resolve("nonexistent")).toBeNull();
  });

  /**
   * The provider is asked about the id that was requested, and the answer is
   * matched back to it. A provider that echoed a different result -- or a
   * caller passing an id that widened into several -- must not have that
   * result attached to the Message.
   */
  it("refuses a result whose id is not the one asked for", async () => {
    const { fetcher } = stubFetch({ results: [tenorResult("something-else")] });
    const provider = createGifProvider(CONFIG, fetcher);

    expect(await provider.resolve("abc")).toBeNull();
  });

  it("refuses an id that is not shaped like one the provider issues", async () => {
    let called = false;
    const provider = createGifProvider(CONFIG, async () => {
      called = true;
      return new Response("{}");
    });

    expect(await provider.resolve("../../etc/passwd")).toBeNull();
    // Refused before any request, so a malformed id cannot reach the provider
    // as a crafted query string either.
    expect(called).toBe(false);
  });
});

describe("createGifProvider without a key", () => {
  /**
   * Search degrades rather than the application refusing to run. Stickers are
   * bundled and need no credential, so a checkout with no provider key is a
   * usable application with one tab switched off -- not a broken one.
   */
  it("is unavailable rather than absent", async () => {
    const provider = createGifProvider({ apiKey: undefined }, async () => {
      throw new Error("must not reach the provider");
    });

    expect(provider.configured).toBe(false);
    await expect(provider.search("dancing", 20)).rejects.toBeInstanceOf(
      GifSearchUnavailableError,
    );
    expect(await provider.resolve("abc")).toBeNull();
  });

  it("is configured when a key is present", () => {
    expect(createGifProvider(CONFIG, async () => new Response("{}")).configured).toBe(true);
  });
});
