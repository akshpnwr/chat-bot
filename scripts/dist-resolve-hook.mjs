/**
 * Makes the compiled server runnable under plain Node.
 *
 * Two specifier styles in `src/` are resolved by the bundler in development and
 * by nothing at all in production, so `dist` is emitted holding specifiers Node
 * cannot follow:
 *
 * - `@/lib/db`, the path alias from tsconfig. `tsc` type-checks it and emits it
 *   verbatim; rewriting aliases is a bundler's job, not the compiler's.
 * - `./db`, extensionless. Legal under `moduleResolution: "bundler"`, and
 *   forbidden in real ESM, where the extension is mandatory.
 *
 * Next.js bundles the app's own code, so this only ever mattered to the custom
 * server -- which is why `npm run dev` (tsx, which resolves both) worked while
 * `npm run start` did not.
 *
 * A resolution hook rather than a source-wide edit: the alternative is adding
 * `.js` to every relative import in `src/` and dropping the `@/` alias the rest
 * of the codebase reads well with, which is a large diff across files this
 * ticket has no other reason to touch. This keeps the fix in one file, at the
 * boundary where the mismatch actually lives.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

/** `dist/`, since this file is copied to its root as `dist/resolve-hook.mjs`. */
const distRoot = dirname(fileURLToPath(import.meta.url));

/** Candidate files for a specifier Node was given without an extension. */
function candidates(basePath) {
  return [`${basePath}.js`, resolvePath(basePath, "index.js")];
}

export function resolve(specifier, context, nextResolve) {
  // `@/x` maps to the compiled `src`, which `tsc` emits at dist/src because
  // rootDir is the project root.
  if (specifier.startsWith("@/")) {
    const base = resolvePath(distRoot, "src", specifier.slice(2));
    for (const candidate of candidates(base)) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  // A relative specifier that named no extension. Resolved against the
  // importing module rather than the process, so nesting stays correct.
  if (specifier.startsWith(".") && !/\.[mc]?js$/.test(specifier)) {
    const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : distRoot;
    const base = resolvePath(parent, specifier);
    for (const candidate of candidates(base)) {
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}
