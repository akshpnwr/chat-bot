import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import * as nsfw from "nsfwjs";
import { classificationVerdict, type Classification, type NudityVerdict } from "./nudity-rule";

/**
 * The model half of image moderation: pixels in, probabilities out, handed to
 * the rule next door.
 *
 * Inference runs in this process on TensorFlow's WASM backend. That is not the
 * first choice but the fallback ticket #10 asked to be recorded: the native
 * `@tensorflow/tfjs-node` addon cannot be installed at all, because its
 * prebuilt binaries return 404 for every N-API version it claims. ADR-0007
 * carries the spike that established this along with the memory it costs --
 * 121 MB, inside Render's 512 MB, which is what makes running it here viable.
 *
 * The size of that figure is the whole reason for the module's shape. It is
 * paid once, by a single model held for the process's life, rather than per
 * image -- loading per classification would turn a fixed 121 MB into a
 * per-request one and put a multi-second load in front of every upload.
 */

const require = createRequire(import.meta.url);

/**
 * The `.wasm` binaries, resolved from the installed package rather than
 * fetched from a CDN.
 *
 * tfjs-backend-wasm defaults to loading them from jsdelivr. A moderation path
 * that reaches out to a third party is one that fails whenever that third
 * party does -- and a moderation check that fails is a check that either
 * blocks every upload or, far worse, is tempted to wave them through. Pointing
 * at the copy npm already installed makes classification a local operation
 * with no network in it.
 */
function useLocalWasmBinaries(): void {
  const packageEntry = require.resolve("@tensorflow/tfjs-backend-wasm");
  // setWasmPaths treats a trailing-slash string as a directory prefix.
  setWasmPaths(`${dirname(packageEntry)}/`);
}

/**
 * The loaded model, as a promise rather than a value.
 *
 * Holding the promise rather than awaiting it into a variable is what makes
 * concurrent first uploads share one load. Two images arriving before the
 * model is ready both await the same promise; a `let model` guarded by an
 * `if (!model)` would start a second 74 MB load for the second image, because
 * the check and the assignment are separated by an await.
 */
let loading: Promise<nsfw.NSFWJS> | null = null;

/**
 * The WASM backend, brought up once and awaited by everything that touches a
 * tensor.
 *
 * Held apart from the model below because the two are needed at different
 * moments. A tensor is *constructed* before it is classified -- the decoder
 * builds one from the uploaded pixels -- and `tf.tensor3d` throws outright if
 * the highest-priority backend has not been initialised. Folding this into
 * `model()` alone would mean the backend came up only when the model was asked
 * for, which is one step too late for the caller that made the tensor.
 */
let backend: Promise<void> | null = null;

export function nudityBackendReady(): Promise<void> {
  if (backend === null) {
    useLocalWasmBinaries();
    backend = tf.setBackend("wasm").then(() => tf.ready());
  }
  return backend;
}

/**
 * Whether the model has finished loading, answerable without awaiting it.
 *
 * A flag rather than inspecting `loading`, because a promise cannot be asked
 * whether it has settled without awaiting it -- and the health endpoint has to
 * answer synchronously while the load is still in flight, which is precisely
 * the state worth reporting.
 *
 * Held on `globalThis` for the same reason the Prisma client is (`src/lib/db.ts`),
 * and it is load-bearing here rather than merely tidy. The custom server warms
 * the classifier through Node's own resolver (`server/main.ts`), while the
 * health route reaches this file through Next's bundler graph. Those are two
 * instances of this module, each with its own module-level state, so a plain
 * `let` would be set on the instance that did the warming and read on the one
 * that did not -- reporting `loading` forever on a process whose model is
 * ready.
 *
 * Nothing gates classification on this. It is reported, not enforced: an image
 * arriving mid-load is classified on demand by awaiting the same promise, so a
 * false here costs latency rather than allowing a bypass.
 */
const globalForClassifier = globalThis as unknown as { nudityClassifierReady?: boolean };

/** Whether the nudity classifier has finished loading. */
export function nudityClassifierReady(): boolean {
  return globalForClassifier.nudityClassifierReady === true;
}

/**
 * Sets readiness directly, so a test can reach the ready state without paying
 * for a 74 MB load.
 *
 * Exported rather than left to tests to write the global themselves: the key
 * is a string, and a test that spells it out is coupled to that spelling
 * through a cast that makes the mistake look type-checked. Renaming the key
 * would then leave the test passing against a flag nothing reads.
 */
export function setNudityClassifierReadyForTest(ready: boolean): void {
  globalForClassifier.nudityClassifierReady = ready;
}

function model(): Promise<nsfw.NSFWJS> {
  if (loading === null) {
    loading = nudityBackendReady()
      // No argument: nsfwjs 4.4.0 carries MobileNetV2's weights in the package
      // itself and loads them from memory, so this too involves no network.
      .then(() => nsfw.load())
      .then((loaded) => {
        globalForClassifier.nudityClassifierReady = true;
        return loaded;
      });
  }
  return loading;
}

/**
 * Loads the model ahead of the first upload.
 *
 * Called at server startup so the cost lands where nobody is waiting, rather
 * than on whoever happens to send the first image. It is an optimisation
 * rather than a requirement -- `classifyImage` loads on demand if this was
 * never called, which is what keeps tests from having to arrange it.
 */
export function warmNudityClassifier(): Promise<unknown> {
  return model();
}

/**
 * How an image is decoded and handed to the model.
 *
 * Injected rather than imported so this module stays free of a native image
 * decoder. The caller supplies the pixels; see `decodeToTensor` in the upload
 * path.
 */
export type ImageTensor = tf.Tensor3D;

/**
 * Classifies an image and rules on it.
 *
 * The tensor is disposed here, in a `finally`, rather than by the caller.
 * WASM tensors live outside the JavaScript heap and are not collected when the
 * last reference drops, so a leak here is not a heap that grows a little but a
 * process that walks into the memory limit the spike went to the trouble of
 * measuring. Doing it in this module means every caller gets it right by
 * default rather than by remembering.
 */
export async function classifyImage(image: ImageTensor): Promise<NudityVerdict> {
  try {
    const classifier = await model();
    const predictions = await classifier.classify(image);

    // The model returns an array of {className, probability}, ordered by
    // confidence. Folded into the full vector the rule expects, with every
    // class defaulting to zero -- an absent class means the model gave it no
    // weight, which is exactly zero rather than missing data.
    const scores: Classification = {
      Drawing: 0,
      Neutral: 0,
      Hentai: 0,
      Porn: 0,
      Sexy: 0,
    };
    for (const prediction of predictions) {
      if (prediction.className in scores) {
        scores[prediction.className as keyof Classification] = prediction.probability;
      }
    }

    return classificationVerdict(scores);
  } finally {
    image.dispose();
  }
}
