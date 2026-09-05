/**
 * Copies the module-resolution hook into `dist`.
 *
 * `tsc` compiles TypeScript and copies nothing else, so the hook -- which is
 * hand-written `.mjs` precisely because it must not be compiled -- would
 * otherwise be missing from the very output it exists to make runnable.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

mkdirSync(resolve(root, "dist"), { recursive: true });

for (const name of ["dist-resolve-hook.mjs", "dist-register-hook.mjs"]) {
  copyFileSync(
    resolve(root, "scripts", name),
    resolve(root, "dist", name.replace("dist-", "")),
  );
}

console.log("[build] resolution hook copied into dist");
