import sharp from "sharp";
import * as tf from "@tensorflow/tfjs";
import { nudityBackendReady, type ImageTensor } from "./nudity";

/**
 * Turning uploaded bytes into pixels the model can look at.
 *
 * This is the piece `nudity.ts` deliberately does not contain. Keeping the
 * decoder out of that module is what lets the classifier be a thin wrapper
 * over the model, and it is why the pixel source is a parameter rather than an
 * import: a JPEG, a PNG and a WebP are three different decoders, and none of
 * them is a decision about nudity.
 *
 * Decoding is done by sharp rather than by a canvas or by tfjs's own image
 * helpers. `tf.node.decodeImage` belongs to `@tensorflow/tfjs-node`, which
 * ADR-0007 records as uninstallable; a headless canvas would be a second
 * native dependency for a job sharp already does, and Next.js has it installed
 * regardless.
 */

/**
 * The side length the model expects.
 *
 * nsfwjs's MobileNetV2 graph model is trained at 224x224 and resizes anything
 * else itself. Doing it here instead means the tensor that reaches WASM memory
 * is 224x224x3 rather than however many megapixels were uploaded -- which for
 * an 8 MB photograph is the difference between a 600 KB allocation and a
 * 100 MB one, in the process ADR-0001 gave 512 MB.
 */
const MODEL_INPUT_PX = 224;

/**
 * Decodes an uploaded image into the tensor the classifier takes.
 *
 * The alpha channel is dropped and the image is flattened onto white first.
 * A transparent PNG decoded straight to three channels leaves whatever pixels
 * happened to sit under the transparency, which is not what anybody looking at
 * the image would see -- and moderation has to rule on the visible image
 * rather than on what the file technically stores.
 *
 * An animated GIF or WebP is read as its first frame, which is sharp's default.
 * That is a known limit rather than an oversight: reading every frame would
 * multiply the cost of the check by the frame count, and the first frame is
 * what a recipient sees before anything else.
 *
 * A file that is not a decodable image throws, and the pipeline turns that
 * into a refusal (see `moderateImageMessage`) rather than a delivery.
 */
export async function decodeToTensor(image: Buffer): Promise<ImageTensor> {
  const { data, info } = await sharp(image)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(MODEL_INPUT_PX, MODEL_INPUT_PX, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3) {
    throw new Error(`Expected three channels after decoding, got ${info.channels}`);
  }

  // Awaited before the tensor is built, not merely before it is classified.
  // `tf.tensor3d` allocates against the active backend, and tfjs throws rather
  // than initialising one on demand -- so the tensor cannot be constructed at
  // all until WASM is up.
  await nudityBackendReady();

  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
}
