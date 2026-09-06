import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Packages Next must leave in `node_modules` rather than bundle into its
   * server chunks.
   *
   * Each of these resolves something at runtime that a bundler cannot follow.
   * `@prisma/client` is a re-export of a client the generator writes into
   * `node_modules`. The TensorFlow packages are worse: `nudity.ts` locates the
   * `.wasm` binaries with `require.resolve` so the backend loads them from disk
   * rather than from a CDN, and inside a bundle that resolve no longer points
   * at the installed package -- so `setWasmPaths` aims at nothing, the WASM
   * kernels never register, and the first tensor operation fails with a missing
   * kernel rather than with anything that names the cause. `sharp` and the
   * `nsfwjs` model loader load native and binary assets the same way.
   *
   * This is invisible in development, which is what made it expensive: `npm run
   * dev` runs through tsx and never bundles, so every one of these resolves
   * correctly and only a built server shows the fault.
   */
  serverExternalPackages: [
    "@prisma/client",
    "@tensorflow/tfjs",
    "@tensorflow/tfjs-backend-wasm",
    "nsfwjs",
    "sharp",
  ],
};

export default nextConfig;
