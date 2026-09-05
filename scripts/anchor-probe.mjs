/**
 * Scroll-anchoring probe for the virtualized Message list.
 *
 * Measures one thing: when an older page is prepended, does the Message the
 * reader is looking at stay where it was?
 *
 * WHY THIS SCRIPT EXISTS AS A FILE rather than an ad-hoc evaluate: an earlier
 * attempt at this bug measured drift by teleporting `scrollTop` across
 * thousands of pixels and comparing a row's position before and after. That is
 * invalid -- the tracked row is virtualized away by the teleport, so "before"
 * and "after" read two different DOM elements and the difference is noise. Five
 * fixes were built against that noise. The rules below exist to make that
 * mistake impossible to repeat:
 *
 *   1. Never teleport. Nudge by a small delta so the tracked row stays mounted.
 *   2. Track a row that is genuinely rendered and in view at both samples,
 *      identified by its stable key -- never by index, which shifts on prepend.
 *   3. Always run the CONTROL case, in which no page loads and the true answer
 *      is therefore exactly 0. If the control is nonzero, the harness is
 *      broken and its numbers mean nothing. Trust nothing else it says.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:3000";
const EMAIL = process.env.PROBE_EMAIL ?? "ada@example.com";
const PASSWORD = process.env.PROBE_PASSWORD ?? "demo-password-1";
const NUDGE_PX = 60;
/** Mirrors LOAD_OLDER_THRESHOLD_PX in the component under test. */
const LOAD_THRESHOLD_PX = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(page) {
  // The database is a serverless branch that suspends when idle, so the first
  // request after a pause fails with a connection error rather than a bad
  // credential. Retrying is what makes this loop deterministic; without it the
  // probe reports a failure that has nothing to do with the bug.
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
      // better-auth rejects a cross-origin-looking request; a fetch issued from
      // the request context carries no Origin unless it is set explicitly.
      headers: { origin: BASE },
      data: { email: EMAIL, password: PASSWORD },
    });
    if (res.ok()) return;
    lastStatus = res.status();
    await sleep(2500);
  }
  throw new Error(`sign-in failed after retries: ${lastStatus}`);
}

/** The scroll container, plus the row-position reader used for both samples. */
const READER = `(() => {
  const el = document.querySelector('[role="log"]');
  if (!el) return null;
  const rows = [...el.querySelectorAll('[data-index]')];
  const box = el.getBoundingClientRect();
  // A row is "in view" when it is fully inside the viewport -- so it is real,
  // mounted, and will survive a small nudge without being recycled.
  const visible = rows
    .map((r) => ({ node: r, top: r.getBoundingClientRect().top - box.top }))
    .filter((r) => r.top > 20 && r.top < box.height - 80);
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    count: rows.length,
    keys: visible.map((r) => r.node.getAttribute('data-probe-key')),
    tops: visible.map((r) => r.top),
  };
})()`;

/**
 * Tags every rendered row with its identity, so a row can be followed across a
 * prepend. `data-index` cannot do this: a prepend shifts every index by the
 * page size, so the same index is a different Message afterwards.
 */
const TAG = `(() => {
  const el = document.querySelector('[role="log"]');
  for (const row of el.querySelectorAll('[data-index]')) {
    if (!row.dataset.probeKey) {
      const body = row.textContent.trim().slice(0, 40);
      row.dataset.probeKey = body;
    }
  }
})()`;

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await signIn(page);
  await page.goto(`${BASE}/app`);

  // Open the Conversation with the 10,000-Message history.
  //
  // Which one that is matters: the default selection is a short Conversation
  // that fits on screen, and a Conversation with no older page to fetch cannot
  // exhibit a prepend bug at all. An earlier probe measured that one and saw
  // nothing, which is not the same as there being nothing to see.
  await page.waitForSelector('[role="log"]', { timeout: 20000 });
  const deep = page.locator("button", { hasText: "Message 10000" });
  await deep.first().click();
  await sleep(1500);
  await page.waitForFunction(
    `document.querySelectorAll('[data-index]').length > 3`,
    { timeout: 20000 },
  );

  const results = {};

  // Settle: scroll up away from the bottom, then wait until nothing is moving
  // and no page fetch is outstanding. Measuring during settle is measuring the
  // settle, not the bug.
  async function settle(label) {
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      const s = await page.evaluate(READER);
      if (s && s.count > 0 && s.scrollHeight === last) {
        // Three consecutive identical heights: measurement has finished and no
        // fetch is outstanding. Two is not enough -- a page can land between
        // any two samples.
        if (++stable >= 3) return s;
      } else {
        stable = 0;
      }
      last = s?.scrollHeight ?? -1;
      await sleep(150);
    }
    const s = await page.evaluate(READER);
    console.error(`WARNING: ${label} never fully settled`, JSON.stringify(s && {
      scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, count: s.count,
    }));
    return s;
  }

  await page.evaluate(`(() => {
    const el = document.querySelector('[role="log"]');
    el.scrollTop = el.scrollHeight - el.clientHeight - 1500;
  })()`);
  await settle("initial");
  await sleep(600);
  await settle("initial-2");

  /**
   * One trial: tag rows, sample, nudge, sample again, and report how far the
   * tracked row moved relative to where the scroll itself moved it.
   *
   * Expected: a row's viewport position changes by exactly -delta when the
   * reader scrolls by delta and nothing else happens. Anything else is drift.
   */
  async function trial(label, delta) {
    await page.evaluate(TAG);
    const before = await page.evaluate(READER);
    await page.evaluate(`(() => {
      document.querySelector('[role="log"]').scrollTop += ${delta};
    })()`);
    await sleep(1200); // let any triggered page load land and remeasure
    await page.evaluate(TAG);
    const after = await page.evaluate(READER);

    // Follow the SAME Message, by key, across both samples.
    let drift = null;
    let tracked = null;
    for (let i = 0; i < before.keys.length; i++) {
      const key = before.keys[i];
      const j = after.keys.indexOf(key);
      if (key && j !== -1) {
        const expected = before.tops[i] - delta;
        drift = after.tops[j] - expected;
        tracked = key;
        break;
      }
    }
    const loaded = after.count > before.count || after.scrollHeight > before.scrollHeight;
    results[label] = {
      drift,
      tracked,
      pageLoaded: loaded,
      countBefore: before.count,
      countAfter: after.count,
      shBefore: before.scrollHeight,
      shAfter: after.scrollHeight,
    };
    return results[label];
  }

  // CONTROL: nudge downward, away from the load threshold. No page can load,
  // so the true drift is exactly 0. This validates the harness itself.
  const control = await trial("control", NUDGE_PX);

  // TREATMENT: park just below the load threshold, then nudge across it.
  //
  // Deliberately NOT a jump to the top. A large jump recycles every mounted
  // row, so the Message tracked before the prepend no longer exists after it
  // and there is nothing to compare -- which reads as phantom drift if the
  // harness guesses, and as `null` here because it refuses to. A small nudge
  // keeps the tracked Message mounted across the whole event.
  await page.evaluate(`(() => {
    document.querySelector('[role="log"]').scrollTop = ${LOAD_THRESHOLD_PX} + 120;
  })()`);
  await sleep(400);
  await settle("pre-treatment");

  await page.evaluate(TAG);
  const before = await page.evaluate(READER);
  await page.evaluate(`(() => {
    const el = document.querySelector('[role="log"]');
    el.scrollTop -= 150; // crosses the threshold, triggering the older page
  })()`);
  await sleep(2500);
  await page.evaluate(TAG);
  const after = await page.evaluate(READER);

  let drift = null;
  let tracked = null;
  for (let i = 0; i < before.keys.length; i++) {
    const key = before.keys[i];
    const j = after.keys.indexOf(key);
    if (key && j !== -1) {
      // The reader scrolled up by 150, so the tracked Message should sit
      // exactly 150px lower in the viewport. Any other number is the prepend
      // moving what the reader was looking at.
      const expected = before.tops[i] + 150;
      drift = after.tops[j] - expected;
      tracked = key;
      break;
    }
  }
  const treatment = {
    drift,
    tracked,
    pageLoaded: after.scrollHeight > before.scrollHeight,
    grew: after.scrollHeight - before.scrollHeight,
    shBefore: before.scrollHeight,
    shAfter: after.scrollHeight,
    topBefore: before.scrollTop,
    topAfter: after.scrollTop,
  };
  results.treatment = treatment;

  console.log(JSON.stringify(results, null, 2));

  const bad = control.drift === null || Math.abs(control.drift) > 1;
  if (bad) {
    console.log("\nHARNESS INVALID: control drift is not ~0. Numbers above mean nothing.");
    await browser.close();
    process.exit(2);
  }
  console.log("\nharness valid (control drift ~0)");
  if (!treatment.pageLoaded) {
    // A run in which no page prepended proves nothing: the bug's trigger never
    // fired. Reporting PASS here would be the harness lying.
    console.log("HARNESS INVALID: no page was prepended, so nothing was tested.");
    await browser.close();
    process.exit(2);
  }
  const ok = treatment.drift !== null && Math.abs(treatment.drift) <= 2;
  console.log(ok ? "PASS: anchored" : `FAIL: drifted ${treatment.drift}px on prepend`);
  await browser.close();
  process.exit(ok ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(3);
});
