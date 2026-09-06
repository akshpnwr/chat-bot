import { createGifProvider, type GifProvider } from "./tenor";

/**
 * The application's one GIF provider, built from the environment.
 *
 * Separate from the adapter so that `tenor.ts` stays a pure function of its
 * config and its `fetch` -- the credential and the global live here, and
 * nothing that imports the adapter for testing drags them in.
 *
 * Built lazily and then held, rather than at module load. The route that uses
 * it is rendered on the server, and reading the environment at import time
 * would fix the answer at build time rather than at run time.
 */
let provider: GifProvider | null = null;

/**
 * The provider, configured if `GIFS_API_KEY` is set and unconfigured if not.
 *
 * An unset key is a supported state rather than a fault: stickers are bundled
 * and need no credential, so a checkout with no key is a working application
 * with the GIF tab reporting itself unavailable. Failing at startup instead
 * would make a credential a precondition for running anything at all.
 */
export function gifProvider(): GifProvider {
  provider ??= createGifProvider(
    { apiKey: process.env.GIFS_API_KEY },
    (url) => fetch(url),
  );
  return provider;
}
