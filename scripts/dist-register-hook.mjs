/**
 * Registers the resolution hook with Node's module loader.
 *
 * A resolver runs on the loader thread, so it has to be handed to `register`
 * rather than merely imported -- importing it would load the module into the
 * main thread, where its `resolve` export is never consulted and the server
 * fails exactly as it did without it.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-hook.mjs", pathToFileURL(import.meta.filename));
