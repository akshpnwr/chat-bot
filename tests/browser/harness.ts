import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Two real browsers against a real server, which is the only way the
 * reconnection guarantees can actually be checked.
 *
 * Everything below the UI is already covered by the integration tests, and they
 * run far faster. What they cannot see is the part that only exists in a
 * browser: whether the client re-syncs when the socket comes back, whether an
 * unacknowledged Message survives a reload, and whether the recipient's screen
 * ends up holding the same Conversation as the sender's. Those are properties
 * of a running system, so they are tested on one.
 */

/** The port these tests run their own server on, clear of a dev server on 3000. */
export const TEST_PORT = Number(process.env.BROWSER_TEST_PORT ?? 3100);
export const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

/**
 * How long the server is given to answer once it has been spawned. Generous
 * because the first boot follows a full production build, but bounded so a
 * server that will never come up fails with its own log rather than hanging.
 */
const SERVER_BOOT_TIMEOUT_MS = 120_000;

export interface RunningServer {
  /**
   * Kills the process. Used both for teardown and, in the restart test, as the
   * failure being simulated -- a server that dies mid-conversation.
   */
  stop: () => Promise<void>;
}

/** Whether the server is up and answering right now. */
async function isServing(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/sign-in`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isServing()) return;
    if (Date.now() > deadline) {
      throw new Error(`Server did not become ready within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * The running server, restarted only if it is not answering.
 *
 * The restart test kills the server deliberately and boots a new one, but a
 * test that fails partway can leave it dead -- and every test after it would
 * then fail for that reason rather than its own. Checking before each test is
 * what keeps one test's damage from being read as the next one's result.
 */
export async function ensureServer(current: RunningServer): Promise<RunningServer> {
  if (await isServing()) return current;
  await current.stop().catch(() => undefined);
  return startServer();
}

/**
 * Frees the suite's port, whatever is holding it.
 *
 * Best-effort: if nothing is listening there is nothing to kill, and the bind
 * that follows is the real check either way.
 */
async function killWhateverHoldsThePort(): Promise<void> {
  await new Promise<void>((resolve) => {
    const command =
      process.platform === "win32"
        ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${TEST_PORT} ^| findstr LISTENING') do @taskkill /f /pid %a`
        : `lsof -ti tcp:${TEST_PORT} | xargs -r kill -9`;

    const child = spawn(command, {
      shell: true,
      stdio: "ignore",
    });
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
    setTimeout(resolve, 10_000).unref();
  });
}

/** Built once per run, then reused -- including by the restart test's reboot. */
let built: Promise<void> | null = null;

/**
 * Compiles the app the suite runs against.
 *
 * Awaited by every `startServer`, but the promise is memoised, so the restart
 * test's second boot reuses the first build rather than paying for it again.
 */
function buildOnce(): Promise<void> {
  built ??= new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "build"], {
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let log = "";
    child.stdout?.on("data", (chunk: Buffer) => void (log += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => void (log += chunk.toString()));

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Building the app for the browser suite failed.\n\n${log}`));
    });
  });
  return built;
}

/**
 * Boots the real server -- the custom one, so Socket.IO is attached exactly as
 * it is in production rather than being stubbed for the test.
 *
 * Production rather than dev mode, for two reasons. Next's dev server detects
 * an already-running instance and attaches to it instead of honouring PORT, so
 * a developer with `npm run dev` open would have this suite silently drive
 * their server on 3000 rather than its own. And the restart test kills the
 * process and boots it again mid-run, which dev-mode recompilation makes slow
 * and noisy -- the thing under test is a socket recovering, not a bundler.
 *
 * Runs against DATABASE_URL, the same database the seeded demo accounts live
 * in, because these tests sign in as those accounts through the real login
 * form. They only add Messages; they never truncate.
 */
export async function startServer(): Promise<RunningServer> {
  await buildOnce();

  // Anything already holding the port is killed rather than waited for or
  // reused. A server left behind by an earlier run answers healthily while
  // running the previous build with a different environment, so adopting it
  // means testing code that is not the code under test -- which surfaces as
  // sign-ins failing for no visible reason. Owning the port outright is what
  // makes each run's server unambiguously its own.
  await killWhateverHoldsThePort();

  const freeBy = Date.now() + 30_000;
  while ((await isServing()) && Date.now() < freeBy) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // The same entry point `npm run start` uses, resolution hook included, so
  // the suite exercises the real production boot rather than a variant of it.
  const child: ChildProcess = spawn(
    "node",
    ["--import", "./dist/register-hook.mjs", "dist/server/main.js"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(TEST_PORT),
        // better-auth validates the request origin against this, so leaving it
        // at the developer's :3000 makes every sign-in from the suite's own
        // origin fail -- silently, as a form that never navigates.
        BETTER_AUTH_URL: BASE_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );

  // Held rather than inherited, so a boot failure can be reported with the
  // server's own explanation instead of an opaque timeout.
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => void (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => void (log += chunk.toString()));

  const stop = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      // The shell wrapper on Windows means the child is a tree, not one
      // process, so killing the pid alone can leave the port held.
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
      // Don't hang teardown on a process that will not go quietly.
      setTimeout(resolve, 10_000).unref();
    });

  try {
    await waitForServer(SERVER_BOOT_TIMEOUT_MS);
    await warmDatabase();
  } catch (cause) {
    await stop();
    throw new Error(`Test server failed to start.\n\n${log}`, { cause });
  }

  return { stop };
}

/**
 * Absorbs the database's cold start.
 *
 * The Postgres branch suspends when idle, and the request that wakes it fails
 * outright rather than waiting -- so whichever test ran first would fail for a
 * reason that has nothing to do with it. Spending that failure here, on a
 * request nothing depends on, is what keeps it out of the results.
 */
async function warmDatabase(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(`${BASE_URL}/api/auth/get-session`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);

    // Any answer at all means the database was reached; an unauthenticated
    // session is a perfectly good one.
    if (response && response.status < 500) return;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * A signed-in browser client with its own cookie jar.
 *
 * Separate browser contexts rather than separate pages: two tabs of one account
 * have to share a session, and two different accounts must not, and the context
 * boundary is what decides that. Sharing one context for everything would make
 * the two-account test silently test one account twice.
 */
export interface Client {
  page: Page;
  close: () => Promise<void>;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}

/**
 * The session cookies for each account, captured the first time it signs in.
 *
 * Signing in afresh in every test trips better-auth's rate limiter partway
 * through the suite, and the tests after it then fail on a 429 rather than on
 * anything they were checking. Signing in once per account and restoring the
 * cookies thereafter keeps the sessions real -- they were issued by the real
 * login -- while making the number of logins independent of the number of
 * tests.
 */
const sessions = new Map<string, StorageState>();

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Signs in through the real form, so the session cookie is a real one. */
export async function signIn(
  browser: Browser,
  email: string,
  password: string,
): Promise<Client> {
  const saved = sessions.get(email);
  if (saved) {
    const context = await browser.newContext({ storageState: saved });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/app`);
    await page.getByText("Connected").waitFor({ timeout: 60_000 });
    return { page, close: () => context.close() };
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  // The form reports a refused sign-in in its own alert and simply stays put,
  // so waiting only on the navigation would fail as a bare timeout with the
  // actual reason sitting unread on the page.
  try {
    await page.waitForURL(`${BASE_URL}/app`, { timeout: 30_000 });
  } catch (cause) {
    const alert = await page.getByRole("alert").innerText().catch(() => "");
    throw new Error(
      `Signing in as ${email} did not reach /app.${alert ? ` The page said: ${alert}` : ""}`,
      { cause },
    );
  }

  await page.getByText("Connected").waitFor({ timeout: 30_000 });

  // Captured after a login that demonstrably worked, so what is replayed later
  // is a session the server actually issued.
  sessions.set(email, await context.storageState());

  return {
    page,
    close: () => context.close(),
  };
}

/**
 * A second tab of an already signed-in account, sharing its cookie jar.
 * This is what "the same account open in two tabs" means concretely.
 */
export async function openSecondTab(client: Client): Promise<Client> {
  const context = client.page.context();
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/app`);
  await page.getByText("Connected").waitFor({ timeout: 30_000 });
  return { page, close: () => page.close() };
}

/**
 * Severs the socket without telling the client to stop trying.
 *
 * `context.setOffline` is what makes this a real disconnection rather than a
 * simulated one: the client's own reconnection logic runs, the browser's
 * network layer refuses the traffic, and nothing in the application knows it is
 * being tested. Calling `socket.disconnect()` from the page would instead test
 * a path a real outage never takes.
 */
export async function goOffline(client: Client): Promise<void> {
  await client.page.context().setOffline(true);
  await client.page.getByText("Disconnected").waitFor({ timeout: 30_000 });
}

export async function goOnline(client: Client): Promise<void> {
  await client.page.context().setOffline(false);
  await client.page.getByText("Connected").waitFor({ timeout: 60_000 });
}

/** Opens the Conversation with the named person. */
export async function openConversationWith(
  client: Client,
  name: string,
): Promise<void> {
  await client.page.getByRole("button", { name: new RegExp(name, "i") }).first().click();
  await composerOf(client).waitFor({ timeout: 30_000 });
}

/**
 * The send box, addressed by role as well as name: the Messages log is
 * labelled "Messages", which a name-only match also finds.
 */
function composerOf(client: Client) {
  return client.page.getByRole("textbox", { name: "Message" });
}

/** Writes a Message, whether or not the socket is currently up. */
export async function writeMessage(client: Client, body: string): Promise<void> {
  const composer = composerOf(client);
  await composer.fill(body);
  await composer.press("Enter");
}

/** The Message bodies currently rendered, in the order they are read in. */
export async function renderedBodies(client: Client): Promise<string[]> {
  return client.page.locator("[data-message-body]").allInnerTexts();
}

/**
 * Waits for a Message to be on screen exactly once.
 *
 * Counting rather than merely finding it is the point: a duplicate delivered by
 * reconnection would still satisfy "is visible", and a duplicate is precisely
 * what these tests exist to rule out.
 */
export async function expectExactlyOnce(client: Client, body: string): Promise<void> {
  // Matched whole, not as a substring. `hasText` is a substring test, so a body
  // like "two-tabs-<run>" would also match "two-tabs-recover-<run>" from
  // another test and report a duplicate that does not exist. These tests exist
  // to detect duplicates, so their matcher must not manufacture them.
  const exact = client.page
    .locator("[data-message-body]")
    .filter({ hasText: new RegExp(`^${escapeForRegExp(body)}$`) });

  await exact.first().waitFor({ timeout: 60_000 });

  const count = await exact.count();
  if (count !== 1) {
    throw new Error(`Expected "${body}" exactly once, found it ${count} times`);
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
