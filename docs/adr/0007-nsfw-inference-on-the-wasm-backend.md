# NSFW inference runs on tfjs's WASM backend, in process

Ticket #10 asked for a spike before anything was built on top of it: confirm the nudity
detection model and its runtime fit inside the deployment's memory limit, and record the
fallback if they do not. ADR-0001 had chosen a single Node process on Render's free tier --
512 MB -- partly so an in-process NSFW model would have somewhere to live, and named
`@tensorflow/tfjs-node` as the runtime. That was the plan's one unverified assumption.

The spike is `scripts/nsfw-memory-spike.mjs`, kept in the repo so the number can be re-taken
rather than trusted from this file. It measures resident set size rather than heap, because
the model's weights live in native or WASM memory that `heapUsed` does not count -- reporting
the heap would say "fits" for a process the platform kills.

## What the spike found

**`@tensorflow/tfjs-node` cannot be installed at all.** Its prebuilt binaries are fetched from
`storage.googleapis.com/tf-builds/pre-built-binary`, and every napi version it declares
support for (3 through 8) returns 404 there, on Linux as well as Windows. Installation
therefore falls back to compiling the N-API addon from source, which needs a C++ toolchain and
a libtensorflow download that Render's free build environment is not set up for. This is not a
memory finding -- the native backend never got far enough to measure one.

**The WASM backend fits comfortably.** With `@tensorflow/tfjs` on
`@tensorflow/tfjs-backend-wasm`, no native build is involved and the whole stack installs from
plain npm packages:

| Measurement | Value |
| --- | --- |
| Baseline RSS, before loading anything | 46.7 MB |
| After the WASM backend initialises | 77.2 MB |
| After the model loads | 150.6 MB |
| Peak during inference | 167.5 MB |
| Cost of backend + model over baseline | **120.9 MB** |
| Mean latency, 20 classifications | **49.3 ms** |

## Decision

Take the fallback the ticket named. Inference runs in the application process on
`@tensorflow/tfjs-backend-wasm`, using nsfwjs 4.4.0's default MobileNetV2 graph model at
224x224.

The hosted-classification-service alternative the ticket also offered is not needed: 121 MB
inside a 512 MB budget leaves room for Next.js, Prisma and Socket.IO, and keeping inference
in process avoids both a third-party dependency in the moderation path and the per-image cost
of shipping user uploads to someone else.

The model is loaded once at startup and reused, not loaded per image. Loading it per
classification would pay the 74 MB allocation and the load latency on every upload, and would
make the 121 MB figure above a per-request cost rather than a fixed one.

## The threshold rule

The model returns five class probabilities: Drawing, Neutral, Hentai, Porn, Sexy. An image is
refused when `Porn + Hentai >= 0.60`, or when `Sexy >= 0.80`.

Summing Porn and Hentai rather than thresholding each separately is deliberate: they are the
two explicit classes, and an image the model splits evenly between them -- 0.4 and 0.4 -- is
one no per-class threshold of 0.6 would catch, though it is 80% explicit by the model's own
reckoning. Sexy is held to a much higher bar because it covers swimwear and athletic
photographs, where a moderate score is ordinary rather than a signal.

## Consequences

WASM inference is roughly an order of magnitude slower than the native backend would have
been, which is what makes the asynchronous path of ADR-0003 necessary rather than merely
tidy: 50 ms is too long to hold a send's acknowledgement open, so the Message is Accepted as
PENDING and classified after the ack returns.

nsfwjs 4.4.0 carries the MobileNetV2 weights inside the package as base64 and loads them
through an in-memory IO handler, so no network fetch is involved and nothing needs vendoring.
That matters for more than cold-start latency: a moderation path that reached out to a
third-party CDN would fail whenever that CDN did, and a moderation check that fails open is
worse than one that is slow.

`nsfwjs@4.4.0` declares `engines.node: 22.13.0` and warns on newer runtimes. The warning is
advisory -- the package is pure JavaScript over tfjs and runs correctly on Node 24, as the
spike above demonstrates -- but it is why installs print an EBADENGINE warning.
