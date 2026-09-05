import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import {
  BASE_URL,
  ensureServer,
  expectExactlyOnce,
  goOffline,
  goOnline,
  launchBrowser,
  openConversationWith,
  openSecondTab,
  signIn,
  startServer,
  writeMessage,
  type Client,
  type RunningServer,
} from "./harness";

/**
 * The reconnection guarantees, driven through two real browsers against a real
 * server.
 *
 * The integration suite already proves the server returns the right Messages
 * for a given cursor, and the unit suite proves the client folds them in
 * without duplicating. What neither can see is whether the browser actually
 * asks -- whether a socket coming back triggers the sync, whether an
 * unacknowledged Message survives the page that wrote it, and whether the two
 * screens agree at the end. Those only exist in a running system.
 *
 * Each test writes Message bodies unique to that test and that run. These tests
 * append to the seeded database and never clear it, so a fixed body would
 * accumulate copies across runs and the duplicate checks below would start
 * failing on history rather than on anything this run did.
 */

/** A body no other test and no previous run has used. */
let counter = 0;
function uniqueBody(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}`;
}

const ADA = { email: "ada@example.com", password: "demo-password-1" };
const GRACE = { email: "grace@example.com", password: "demo-password-2" };

let server: RunningServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer();
  browser = await launchBrowser();
}, 300_000);

/**
 * A fresh browser per test.
 *
 * These tests deliberately break things -- they cut the network and kill the
 * server -- and a context left in either state is invisible to the next test
 * except as an unrelated-looking failure somewhere else. Rebuilding the browser
 * costs a second or two and makes each test's result its own.
 *
 * The server is checked rather than rebuilt: it is expensive to boot, and only
 * the restart test disturbs it, which it repairs itself.
 */
beforeEach(async () => {
  await browser?.close().catch(() => undefined);
  browser = await launchBrowser();
  server = await ensureServer(server);
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await server?.stop();
});

/** Both demo accounts, each looking at the Conversation they share. */
async function twoClients(): Promise<{ ada: Client; grace: Client }> {
  const ada = await signIn(browser, ADA.email, ADA.password);
  const grace = await signIn(browser, GRACE.email, GRACE.password);
  await openConversationWith(ada, "Grace");
  await openConversationWith(grace, "Ada");
  return { ada, grace };
}

describe("a disconnection", () => {
  it("delivers a Message written while offline, exactly once, once the socket returns", async () => {
    const { ada, grace } = await twoClients();
    const body = uniqueBody("offline-send");

    try {
      await goOffline(ada);
      // Written with no socket at all: this can only reach Grace if the client
      // held it somewhere and retried.
      await writeMessage(ada, body);
      await goOnline(ada);

      await expectExactlyOnce(ada, body);
      await expectExactlyOnce(grace, body);
    } finally {
      await ada.close();
      await grace.close();
    }
  }, 180_000);

  it("delivers the Messages that arrived while the client was away", async () => {
    const { ada, grace } = await twoClients();
    const first = uniqueBody("missed-one");
    const second = uniqueBody("missed-two");

    try {
      await goOffline(ada);
      // Sent to a room Ada's socket is no longer in. The broadcast cannot
      // reach her; only the cursor sync can.
      await writeMessage(grace, first);
      await writeMessage(grace, second);
      await goOnline(ada);

      await expectExactlyOnce(ada, first);
      await expectExactlyOnce(ada, second);
    } finally {
      await ada.close();
      await grace.close();
    }
  }, 180_000);

  it("recovers a long absence, not merely the most recent Messages", async () => {
    const { ada, grace } = await twoClients();
    const bodies = Array.from({ length: 12 }, () => uniqueBody("absence"));

    try {
      await goOffline(ada);
      for (const body of bodies) {
        await writeMessage(grace, body);
      }
      await goOnline(ada);

      // The oldest matters as much as the newest: a sync that recovered only
      // the tail would pass on the last one and fail here.
      await expectExactlyOnce(ada, bodies[0]!);
      await expectExactlyOnce(ada, bodies[bodies.length - 1]!);
    } finally {
      await ada.close();
      await grace.close();
    }
  }, 240_000);
});

describe("an unacknowledged Message", () => {
  it("survives a page reload and is retried", async () => {
    const { ada, grace } = await twoClients();
    const body = uniqueBody("survives-reload");

    try {
      await goOffline(ada);
      await writeMessage(ada, body);
      // Written, so it is in storage; never sent, so the server has never heard
      // of it. Confirmed before the reload, so a failure below cannot be the
      // Message having quietly gone out after all.
      await ada.page
        .locator("[data-message-body][data-pending]", { hasText: body })
        .waitFor({ timeout: 30_000 });

      // The network has to come back before the reload: a browser cannot fetch
      // a document with no network, so reloading offline fails outright rather
      // than testing anything. Restoring first still destroys every trace of
      // the Message except the one in storage, which is the point -- the page
      // that rendered it is gone, and only the outbox can bring it back.
      await goOnline(ada);
      await ada.page.reload();
      await ada.page.getByText("Connected").waitFor({ timeout: 60_000 });
      await openConversationWith(ada, "Grace");

      await expectExactlyOnce(ada, body);
      await expectExactlyOnce(grace, body);
    } finally {
      await ada.close();
      await grace.close();
    }
  }, 240_000);
});

describe("the same account in two tabs", () => {
  it("shows a Message sent from one tab in the other, exactly once", async () => {
    const ada = await signIn(browser, ADA.email, ADA.password);
    const grace = await signIn(browser, GRACE.email, GRACE.password);
    await openConversationWith(ada, "Grace");
    await openConversationWith(grace, "Ada");

    const secondTab = await openSecondTab(ada);
    await openConversationWith(secondTab, "Grace");
    const body = uniqueBody("two-tabs");

    try {
      await writeMessage(ada, body);

      // The sending tab settles from its ack; the other has no ack of its own
      // and needs the broadcast. Both must end up holding it once.
      await expectExactlyOnce(ada, body);
      await expectExactlyOnce(secondTab, body);
      await expectExactlyOnce(grace, body);
    } finally {
      await secondTab.close();
      await ada.close();
      await grace.close();
    }
  }, 180_000);

  it("recovers in both tabs when both were offline", async () => {
    const ada = await signIn(browser, ADA.email, ADA.password);
    const grace = await signIn(browser, GRACE.email, GRACE.password);
    await openConversationWith(ada, "Grace");
    await openConversationWith(grace, "Ada");

    const secondTab = await openSecondTab(ada);
    await openConversationWith(secondTab, "Grace");
    const body = uniqueBody("two-tabs-recover");

    try {
      // One context, so taking it offline takes both tabs with it -- which is
      // what a laptop losing its network actually does.
      await goOffline(ada);
      await writeMessage(grace, body);
      await goOnline(ada);

      await expectExactlyOnce(ada, body);
      await expectExactlyOnce(secondTab, body);
    } finally {
      await secondTab.close();
      await ada.close();
      await grace.close();
    }
  }, 240_000);
});

describe("a server restart mid-conversation", () => {
  it("loses no Accepted Message and duplicates none", async () => {
    const { ada, grace } = await twoClients();
    const before = uniqueBody("restart-before");
    const after = uniqueBody("restart-after");

    try {
      await writeMessage(grace, before);
      await expectExactlyOnce(ada, before);

      // The real failure: the process dies, taking every buffer and every
      // in-memory session with it. Only what reached the database survives,
      // which is precisely what the guarantee is about.
      await server.stop();
      await ada.page.getByText("Disconnected").waitFor({ timeout: 60_000 });

      server = await startServer();
      await ada.page.getByText("Connected").waitFor({ timeout: 120_000 });
      await grace.page.getByText("Connected").waitFor({ timeout: 120_000 });

      // A Message sent after the restart proves the sockets genuinely came
      // back rather than merely reporting that they had.
      await writeMessage(grace, after);

      await expectExactlyOnce(ada, before);
      await expectExactlyOnce(ada, after);
    } finally {
      await ada.close();
      await grace.close();
    }
  }, 300_000);
});

describe("connection status", () => {
  it("is visible to the user and tracks the socket", async () => {
    const ada = await signIn(browser, ADA.email, ADA.password);

    try {
      await expect(ada.page.getByText("Connected")).toBeTruthy();

      await goOffline(ada);
      expect(await ada.page.getByText("Disconnected").count()).toBe(1);

      await goOnline(ada);
      expect(await ada.page.getByText("Connected").count()).toBe(1);
    } finally {
      await ada.close();
    }
  }, 180_000);
});

describe("the harness itself", () => {
  it("serves the app it is testing", async () => {
    const response = await fetch(`${BASE_URL}/sign-in`);
    expect(response.ok).toBe(true);
  });
});
