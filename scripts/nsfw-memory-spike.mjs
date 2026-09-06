/**
 * The spike ticket #10 asks for, run before anything is built on top of it.
 *
 * ADR-0001 chose a single Node process on Render's free tier -- 512 MB of RAM --
 * partly so an in-process NSFW model would have somewhere to live. That the
 * model actually fits in what is left after Next.js, Prisma and Socket.IO have
 * taken their share is the plan's one unverified assumption, and it is the kind
 * that is cheap to test now and expensive to discover in production.
 *
 * What is measured is resident set size, not heap. The model's weights live in
 * native tensor memory when tfjs-node is the backend, which the heap does not
 * count -- reporting `heapUsed` would report a number far below what the host
 * actually enforces, and would say "fits" for a process the platform kills.
 *
 * Run: node scripts/nsfw-memory-spike.mjs [backend]
 *   backend: "node" (default, native N-API) or "wasm" (the documented fallback)
 */

const backendChoice = process.argv[2] ?? "node";

function rssMb() {
  return process.memoryUsage().rss / 1024 / 1024;
}

function report(label, value) {
  console.log(`${label.padEnd(34)} ${value}`);
}

const baseline = rssMb();

let tf;
if (backendChoice === "wasm") {
  tf = await import("@tensorflow/tfjs");
  const wasm = await import("@tensorflow/tfjs-backend-wasm");
  await tf.setBackend("wasm");
  void wasm;
} else {
  tf = await import("@tensorflow/tfjs-node");
}
await tf.ready();

const afterBackend = rssMb();

const nsfw = await import("nsfwjs");
// The 224x224 MobileNetV2 graph model -- the smaller of the two nsfwjs ships,
// and the one whose input size matches what we downscale uploads to anyway.
const model = await nsfw.load();

const afterModel = rssMb();

// A synthetic image rather than a fixture: this measures the memory a
// classification costs, and the allocation for a 224x224x3 tensor is the same
// whatever the pixels are. Real images are what the accuracy tests use.
const image = tf.tensor3d(
  new Uint8Array(224 * 224 * 3).fill(128),
  [224, 224, 3],
  "int32",
);

let peak = afterModel;
const started = Date.now();
const ROUNDS = 20;
for (let round = 0; round < ROUNDS; round += 1) {
  const predictions = await model.classify(image);
  if (round === 0) console.log("\nsample prediction:", predictions);
  peak = Math.max(peak, rssMb());
}
const elapsed = Date.now() - started;

image.dispose();

console.log("");
report("backend", tf.getBackend());
report("baseline RSS (MB)", baseline.toFixed(1));
report("after backend load (MB)", afterBackend.toFixed(1));
report("after model load (MB)", afterModel.toFixed(1));
report("peak during inference (MB)", peak.toFixed(1));
report("model+backend cost (MB)", (peak - baseline).toFixed(1));
report(`mean latency over ${ROUNDS} (ms)`, (elapsed / ROUNDS).toFixed(1));
report("tensors still allocated", tf.memory().numTensors);
