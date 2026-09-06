/**
 * Bottom-reachability probe for the virtualized Message list.
 *
 * Measures the user's exact symptom: "I am not able to reach the bottom, it
 * keeps scrolling up." That is NOT the same assertion as anchor-probe.mjs,
 * which measures whether a prepend moves a tracked row. A list can anchor
 * perfectly on prepend and still refuse to stay at the bottom.
 *
 * The assertion: ask the container to go to the bottom, then sample the
 * distance from the bottom repeatedly WITHOUT touching scrollTop again. If
 * something in the component drags the reader upward, that distance grows on
 * its own. A correct list stays at ~0 forever.
 *
 * Rules borrowed from the sibling probe, for the same reasons:
 *   - Always run a CONTROL whose true answer is known, so a broken harness
 *     cannot be mistaken for a bug.
 *   - Never trust a run in which the trigger never fired.
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:3000";
const EMAIL = process.env.PROBE_EMAIL ?? "ada@example.com";
const PASSWORD = process.env.PROBE_PASSWORD ?? "demo-password-1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(page) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await page.request.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE },
      data: { email: EMAIL, password: PASSWORD },
    });
    if (res.ok()) return;
    lastStatus = res.status();
    await sleep(2500);
  }
  throw new Error(`sign-in failed after retries: ${lastStatus}`);
}

/** Distance from the bottom, plus enough state to explain a change in it. */
const READER = `(() => {
  const el = document.querySelector('[role="log"]');
  if (!el) return null;
  return {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    rows: el.querySelectorAll('[data-index]').length,
    loading: !!el.querySelector('p') && el.textContent.includes('Loading earlier'),
  };
})()`;

const GO_BOTTOM = `(() => {
  const el = document.querySelector('[role="log"]');
  el.scrollTop = el.scrollHeight;
})()`;

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await signIn(page);
  await page.goto(`${BASE}/app`);
  await page.waitForSelector('[role="log"]', { timeout: 20000 });

  // ---- CONTROL: a short Conversation, which has no older page to fetch.
  // The true answer here is "stays at the bottom". If this fails, the harness
  // is measuring something other than the bug.
  const control = await measure(page, "control");

  // ---- TREATMENT: the 10,000-Message bulk Conversation, opened COLD.
  //
  // Reloaded rather than clicked into from a settled list. This is the whole
  // trigger: the defect is a race between the opening page of history and the
  // sync drain, and it only exists while the client does not yet know what it
  // holds. Clicking across from a Conversation that has already loaded leaves
  // the hook warm, the race already decided, and the probe green against code
  // that is plainly broken -- which is precisely the mistake the sibling probe
  // warns about, made a second way.
  //
  // Selected by participant rather than by preview text: the bulk thread is
  // Ada's with Alan, and its newest Message is whatever ran last against this
  // database, so matching on "Message 10000" silently stops finding it.
  // Selection is React state with no URL to restore it, so a cold open is a
  // fresh load of /app followed by this being the FIRST Conversation opened.
  await page.reload();
  await page.waitForSelector('[role="log"]', { timeout: 20000 });
  const deep = page.getByRole("button", { name: /Alan/i });
  await deep.first().click();
  await sleep(2000);
  await page.waitForFunction(
    `document.querySelectorAll('[data-index]').length > 3`,
    { timeout: 20000 },
  );
  const treatment = await measure(page, "treatment");

  console.log(JSON.stringify({ control, treatment }, null, 2));

  await browser.close();

  if (control.maxFromBottom > 40) {
    console.log("\nHARNESS INVALID: control could not hold the bottom either.");
    process.exit(2);
  }
  console.log("\nharness valid (control holds the bottom)");

  const ok = treatment.maxFromBottom <= 40;
  console.log(
    ok
      ? "PASS: the bottom is reachable and holds"
      : `FAIL: drifted ${Math.round(treatment.maxFromBottom)}px up from the bottom on its own`,
  );
  process.exit(ok ? 0 : 1);
}

/**
 * Go to the bottom, then watch WITHOUT touching scrollTop again.
 *
 * Sampling rather than checking once: the symptom is a drift that develops
 * over the moments after arriving, so a single reading taken too early sees a
 * bottom that is about to be lost.
 */
async function measure(page, label) {
  await page.evaluate(GO_BOTTOM);
  await sleep(300);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const s = await page.evaluate(READER);
    samples.push(Math.round(s.fromBottom));
    await sleep(250);
  }
  const final = await page.evaluate(READER);
  return {
    label,
    samples,
    maxFromBottom: Math.max(...samples),
    finalFromBottom: Math.round(final.fromBottom),
    rows: final.rows,
    scrollHeight: final.scrollHeight,
  };
}

run().catch((e) => {
  console.error(e);
  process.exit(3);
});
