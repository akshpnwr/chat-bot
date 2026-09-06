import type { Message } from "@prisma/client";
import { rejectImageMessage, visibleImageMessage } from "@/server/messages";
import * as objectStorage from "@/server/storage";
import type { NudityVerdict } from "./nudity-rule";

/**
 * What happens to an Accepted image between PENDING and a decision.
 *
 * This is the asynchronous half ADR-0003 exists for. A send is acknowledged
 * before the image has been looked at -- inference costs ~50 ms on the WASM
 * backend (ADR-0007), which is too long to hold an ack open -- so the Message
 * is stored PENDING and this runs afterwards, turning it into exactly one of
 * VISIBLE or REJECTED.
 *
 * Storage and the classifier are parameters rather than imports at the call
 * site's mercy, so the sequencing here can be stated in tests without a bucket
 * and without loading a 121 MB model. The rule the probabilities are measured
 * against lives in `nudity-rule.ts` and is tested there; what is decided here
 * is what to do with a verdict, and what to do when there isn't one.
 */

/** The slice of object storage the pipeline uses. */
export interface ModerationStorage {
  readObject: (key: string) => Promise<Buffer>;
  promote: (key: string) => Promise<string>;
  discard: (key: string) => Promise<void>;
}

/**
 * What the sender is told when the check itself failed rather than the image.
 *
 * Deliberately distinguishable from a moderation refusal: an image refused for
 * its content is a different thing from one that could not be decoded, and a
 * sender told "explicit content" about a corrupt PNG would reasonably conclude
 * the system is broken -- or, worse, that it is accusing them.
 */
export const UNDECIDABLE_REASON =
  "This image could not be checked, so it was not sent";

/**
 * Classifies one PENDING image and records the decision.
 *
 * It never throws for a bad image. Every failure -- an unreadable object, a
 * format the decoder cannot handle, the model failing to load -- ends in
 * REJECTED rather than in a rethrow, because the alternatives are both worse
 * than a false refusal. Leaving the Message PENDING would strand it forever,
 * visible to its sender as a spinner that never resolves and invisible to the
 * recipient by the read-model filter; delivering it would let an unexamined
 * image through the one check this ticket exists to enforce. Failing closed
 * costs the sender a retry, which is the cheapest of the three.
 *
 * Ordering within each branch matters. On clearance the object is promoted
 * *before* the row is made VISIBLE, so there is no instant in which a
 * recipient can be told about an image that still sits in quarantine; on
 * refusal the row is rejected *before* the object is deleted, so the decision
 * is durable even if the delete fails and leaves litter behind.
 */
export async function moderateImageMessage({
  messageId,
  assetKey,
  classify,
  storage = objectStorage,
}: {
  messageId: string;
  assetKey: string;
  /** Pixels in, verdict out. Injected so tests need no model and no imagery. */
  classify: (image: Buffer) => Promise<NudityVerdict>;
  storage?: ModerationStorage;
}): Promise<Message> {
  let verdict: NudityVerdict;
  try {
    verdict = await classify(await storage.readObject(assetKey));
  } catch (error) {
    console.error("[moderation] classifying an image failed", error);
    verdict = { refused: true, reason: UNDECIDABLE_REASON };
  }

  if (verdict.refused) {
    const rejected = await rejectImageMessage({ messageId, reason: verdict.reason });
    // Deleted after the row is written, and allowed to fail without failing the
    // rejection: the Message is already unreachable by every read route, so a
    // leftover object is litter rather than a way to the content.
    try {
      await storage.discard(assetKey);
    } catch (error) {
      console.error("[moderation] discarding a refused image failed", error);
    }
    return rejected;
  }

  const promoted = await storage.promote(assetKey);
  return visibleImageMessage({ messageId, assetUrl: promoted });
}
