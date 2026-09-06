import { TYPING_TTL_MS } from "./typing";

/**
 * Decides when to tell the server somebody is typing.
 *
 * The acceptance criterion is that typing is throttled rather than emitted per
 * keystroke, and the reason is not merely bandwidth: the server broadcasts a
 * change to the other Participant, so an event per keystroke would have the
 * recipient re-render on every letter the sender types.
 *
 * Two rules, pulling in opposite directions, which is why this is a value with
 * tests rather than a pair of timers scattered through a component:
 *
 *  - Announce rarely enough that a burst of typing costs one event, not thirty.
 *  - Announce often enough that the server's lease never lapses mid-sentence,
 *    which would blink the indicator off while somebody is still writing.
 *
 * Kept free of React and of the socket so both rules are testable against a
 * clock the test moves by hand, rather than against real elapsed time.
 */

/**
 * How often a continuing typist is re-announced.
 *
 * Deliberately under half the server's lease (`TYPING_TTL_MS`), so a single
 * announcement lost to a blip is covered by the next one before the lease
 * lapses. A test pins that relationship, because the two constants are only
 * correct with respect to each other.
 */
export const TYPING_ANNOUNCE_INTERVAL_MS = 2_000;

/**
 * How long a pause counts as having stopped typing.
 *
 * Shorter than the server's lease, so an idle typist is cleared by the explicit
 * stop rather than by waiting out the lease -- the stop is immediate where the
 * lapse would leave the indicator up for the remainder of the TTL.
 */
export const TYPING_IDLE_MS = 3_000;

export interface TypingAnnouncer {
  /** Called on each keystroke; announces only when the throttle allows. */
  keystroke: () => void;
  /** Called periodically; announces a stop once the typist has gone idle. */
  tick: () => void;
  /** Announces a stop immediately, whatever the timers say. */
  stop: () => void;
}

export function createTypingAnnouncer({
  now = Date.now,
  announce,
}: {
  now?: () => number;
  announce: (typing: boolean) => void;
}): TypingAnnouncer {
  /** When the last keystroke landed, or null while not composing. */
  let lastKeystrokeAt: number | null = null;
  /** When the server was last told, so the throttle has something to measure. */
  let lastAnnouncedAt = 0;

  return {
    keystroke() {
      const at = now();
      const wasComposing = lastKeystrokeAt !== null;
      lastKeystrokeAt = at;

      // The first keystroke is announced at once. Waiting out an interval
      // before the first one is what makes an indicator feel late -- by the
      // time it appears, the Message it was announcing is often already sent.
      if (!wasComposing) {
        lastAnnouncedAt = at;
        announce(true);
        return;
      }

      // Mid-burst: renew only when the interval has elapsed. This is both the
      // throttle and the lease renewal -- one announcement serving both.
      if (at - lastAnnouncedAt >= TYPING_ANNOUNCE_INTERVAL_MS) {
        lastAnnouncedAt = at;
        announce(true);
      }
    },

    tick() {
      if (lastKeystrokeAt === null) return;
      if (now() - lastKeystrokeAt < TYPING_IDLE_MS) return;

      lastKeystrokeAt = null;
      announce(false);
    },

    stop() {
      // Nothing to stop. A composer that clears without anybody having typed
      // must not announce a stop the server would broadcast to no purpose.
      if (lastKeystrokeAt === null) return;

      lastKeystrokeAt = null;
      announce(false);
    },
  };
}

/** Re-exported so a caller setting up the two together sees they are related. */
export { TYPING_TTL_MS };
