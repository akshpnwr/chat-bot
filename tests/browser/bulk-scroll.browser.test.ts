import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import {
  ensureServer,
  launchBrowser,
  signIn,
  startServer,
  type Client,
  type RunningServer,
} from "./harness";

/**
 * Opening a large Conversation must not drain it.
 *
 * The bug this pins down looked like a scroll bug and was not one. Nothing
 * moved the reader: `scrollTop` stayed exactly where it was put. What moved was
 * the *end* of the Conversation, because opening it started a reconnect-style
 * sync from Sequence 0 and appended the entire history below the viewport in
 * 200-Message rounds. Reaching the bottom and finding several thousand more
 * pixels beneath you a moment later reads, from the outside, as "it keeps
 * scrolling up".
 *
 * Why this lives in the browser suite rather than beside the other sync tests:
 * the fault is a race between two independent effects -- the first-page fetch
 * and the sync drain -- and neither the pure state functions nor the server
 * query can express it. `applySyncGap` folds a gap in correctly whatever the
 * cursor was; `syncMessages` returns exactly what a cursor of 0 asks for. Both
 * were right. The defect was only ever in which cursor a real client sends, and
 * on a cold open that is decided by effect ordering inside a mounted component.
 * A unit test at either seam would have passed against the bug.
 *
 * These assertions are proven red-capable: with the guard removed from
 * `use-conversation.ts` they fail here, reporting a first cursor of `null`
 * followed by rounds walking `204, 404, 604, ...` and a Conversation grown past
 * 119,000px. With the guard in place they pass.
 *
 * That took one deliberate intervention, and it is `HISTORY_DELAY_MS` below.
 * The defect is a race, and against a production build on a fast machine the
 * first page wins it by a comfortable margin -- measured at 580ms even when the
 * socket connected first -- so an unmodified run is green whether the fix is
 * present or not. That is not the bug being absent; it is the bug being
 * invisible, which is precisely how it reached a user in the first place. The
 * delay widens the window the defect already lives in rather than creating one.
 */

const ADA = { email: "ada@example.com", password: "demo-password-1" };

/**
 * Whose Conversation with Ada holds the seeded bulk history.
 *
 * The seed gives Alan a thread of his own precisely so the 10,000 Messages sit
 * somewhere the other tests do not write to. Named rather than picked by
 * position: which Conversation sorts first depends on what has been sent
 * recently, and measuring the wrong Conversation is exactly how this bug
 * survived an earlier investigation -- a short thread has no history to drain
 * and so cannot exhibit the fault at all.
 */
const BULK_PARTICIPANT = "Alan";

/** How many Messages the seed puts in that Conversation. */
const BULK_MESSAGE_COUNT = 10_000;

/**
 * How long the opening page of history is held back, to hold the race open long
 * enough to observe.
 *
 * Three seconds is chosen against a measurement rather than by feel: on this
 * suite's production build the socket and the first page land within roughly
 * 600ms of each other, so the delay has to clear that comfortably to put the
 * sync first every run. It costs the two tests below three seconds each.
 */
const HISTORY_DELAY_MS = 3_000;

let server: RunningServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer();
  browser = await launchBrowser();
}, 300_000);

beforeEach(async () => {
  await browser?.close().catch(() => undefined);
  browser = await launchBrowser();
  server = await ensureServer(server);
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.stop();
});

/**
 * Opens the seeded 10,000-Message Conversation and waits for it to render.
 *
 * The history is confirmed to actually be there rather than assumed. Every
 * assertion below is about what a *long* Conversation does on open, so opening
 * a short one would make them all pass while testing nothing -- the precise
 * failure mode that let this bug survive an earlier investigation. If the seed
 * has not been run, this says so instead.
 */
async function openBulkConversation(client: Client): Promise<void> {
  await client.page
    .getByRole("button", { name: new RegExp(BULK_PARTICIPANT, "i") })
    .first()
    .click();
  await client.page.waitForFunction(
    `document.querySelectorAll('[data-index]').length > 3`,
    undefined,
    { timeout: 30_000 },
  );

  // Confirmed to have history still unfetched beneath it, rather than by the
  // newest Message: the suite appends to this database and never truncates, so
  // the newest Message is whatever ran last. "The beginning of the
  // conversation" is the banner a Conversation shows once the reader has
  // reached its start, so its *absence* is what says there is more below --
  // which is the only property these assertions depend on. Checked without
  // scrolling, so the check itself cannot trigger the paging it is asking about.
  const atStart = await client.page
    .getByText("This is the beginning of the conversation")
    .count();
  if (atStart > 0) {
    throw new Error(
      `Expected the seeded ${BULK_MESSAGE_COUNT}-Message Conversation with ${BULK_PARTICIPANT}, ` +
        `but this thread's opening page already reaches its start -- it is too short. ` +
        `Run \`npm run db:seed\`: these assertions are meaningless against a short Conversation.`,
    );
  }
}

/**
 * Opens the bulk Conversation as the reader's FIRST Conversation, from a fresh
 * load of the app.
 *
 * This is the trigger, and it is easy to lose. The defect only exists while the
 * client does not yet know what it holds -- so clicking across from a
 * Conversation that has already loaded finds the hook warm, the race already
 * decided, and every assertion below green against plainly broken code. An
 * earlier probe for this bug did exactly that and reported PASS.
 *
 * Selection is React state with no URL to restore it, so "cold" means reloading
 * and then opening this Conversation before any other.
 */
async function coldOpenBulkConversation(client: Client): Promise<void> {
  // Holds back ONLY the opening page of history, so the sync effect reaches the
  // Sync Cursor while the client still does not know what it holds. Nothing
  // else is delayed, and the client is otherwise untouched: the request goes to
  // the real server and returns the real page, just later.
  //
  // Without this the test cannot fail. The race is genuinely there in
  // production -- it is what the user hit -- but the first page usually wins,
  // so asserting on an unmodified run measures machine speed rather than the
  // code. Widening a real window is what makes the assertion mean something;
  // the alternative is a test that passes for reasons unrelated to the fix.
  await client.page.route("**/messages?limit=*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, HISTORY_DELAY_MS));
    await route.continue();
  });

  await client.page.reload();
  await client.page.waitForSelector('[role="log"]', { timeout: 30_000 });
  await openBulkConversation(client);
}

describe("opening a Conversation with a long history", () => {
  it("syncs from what it holds rather than from the beginning", async () => {
    const ada = await signIn(browser, ADA.email, ADA.password);

    try {
      // Every `conversation:sync` this client sends, in order, with the cursor
      // it carried.
      //
      // Asserting on the cursor rather than on how far the viewport drifted is
      // deliberate, and it is the second attempt at this test. Drift is a real
      // symptom but a derived one: it depends on how many rounds have landed by
      // the time the samples are taken, so the same broken build produced red
      // and green runs depending on machine speed. The cursor is the defect
      // itself and is the same value every run -- a client that has not yet
      // loaded its first page reports "I hold nothing", and the server
      // obligingly starts from Sequence 1 (ADR-0002).
      const cursors: string[] = [];
      ada.page.on("websocket", (ws) =>
        ws.on("framesent", (frame) => {
          const payload =
            typeof frame.payload === "string"
              ? frame.payload
              : (frame.payload?.toString() ?? "");
          if (!payload.includes("conversation:sync")) return;
          const match = payload.match(/"since":(null|"?\d+"?)/);
          cursors.push(match?.[1] ?? "unparsed");
        }),
      );

      await coldOpenBulkConversation(ada);
      // Long enough that a drain would have run many rounds by now: against the
      // unfixed client this window held ten or more.
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      expect(
        cursors.length,
        "the client never synced at all, so this test proves nothing",
      ).toBeGreaterThan(0);

      // `null` is the whole bug. It is what a client sends when it is asked for
      // its Sync Cursor before it knows what it holds, and what makes the
      // server stream the Conversation from its start.
      expect(
        cursors[0] ?? "",
        `opened cold and asked to sync from the beginning; cursors: ${cursors.join(", ")}`,
      ).not.toBe("null");

      // One round settles a Conversation with nothing to recover. A drain shows
      // up here as many, each advancing 200 Messages at a time.
      expect(
        cursors.length,
        `opening ran ${cursors.length} sync rounds, which is a drain rather than a check; cursors: ${cursors.join(", ")}`,
      ).toBeLessThanOrEqual(2);
    } finally {
      await ada.close();
    }
  }, 180_000);

  it("does not tell the reader it is catching up", async () => {
    const ada = await signIn(browser, ADA.email, ADA.password);

    try {
      await coldOpenBulkConversation(ada);
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      // "Catching up" means Messages the reader missed are arriving. Opening a
      // Conversation is not that, and during the bug this was displayed
      // continuously while the history drained -- the visible face of a cold
      // open being mistaken for a recovery.
      expect(await ada.page.getByText("Catching up").count()).toBe(0);
    } finally {
      await ada.close();
    }
  }, 180_000);
});
