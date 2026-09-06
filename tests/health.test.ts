import { afterEach, describe, expect, it, vi } from "vitest";
import { healthReport } from "@/server/health";

/**
 * The health endpoint exists to be pinged every ten minutes so Render's free
 * tier does not spin the service down (ADR-0001). What it reports is therefore
 * a decision with consequences: anything it calls unhealthy is something the
 * platform may restart the process over.
 */
describe("healthReport", () => {
  it("reports the process healthy once it is serving", () => {
    const report = healthReport({ uptimeSeconds: 12.7, classifierReady: true });

    expect(report.status).toBe("ok");
  });

  /**
   * The classifier loads after `listen` and takes a few seconds (ADR-0007).
   * A ping arriving during that window must not report the process unhealthy:
   * it is serving, and an image sent before the load finishes is classified on
   * demand rather than let through.
   */
  it("stays healthy while the nudity classifier is still loading", () => {
    const report = healthReport({ uptimeSeconds: 0.4, classifierReady: false });

    expect(report.status).toBe("ok");
    expect(report.classifier).toBe("loading");
  });

  it("reports the classifier ready once it has loaded", () => {
    const report = healthReport({ uptimeSeconds: 30, classifierReady: true });

    expect(report.classifier).toBe("ready");
  });

  /**
   * Uptime is what makes a keep-warm ping legible: a reviewer watching the
   * endpoint can tell a process that has been up for an hour from one that
   * cold-started on the ping they just sent.
   */
  it("reports whole seconds of uptime", () => {
    const report = healthReport({ uptimeSeconds: 12.7, classifierReady: true });

    expect(report.uptimeSeconds).toBe(12);
  });
});

/**
 * The custom server warms the classifier through Node's own resolver, while
 * the health route reaches the same file through Next's bundler graph. Those
 * are two instances of the module, so readiness held in a module-level `let`
 * would be written on one and read on the other -- reporting `loading` forever
 * on a process whose model was ready, which is what a first cut of this
 * endpoint did.
 *
 * Importing the module twice under a reset registry is how that shape is
 * reproduced in a test: a second instance must observe what the first set.
 */
describe("nudityClassifierReady", () => {
  afterEach(async () => {
    const { setNudityClassifierReadyForTest } = await import("@/server/moderation/nudity");
    setNudityClassifierReadyForTest(false);
    vi.resetModules();
  });

  it("is observable from a separately loaded instance of the module", async () => {
    const first = await import("@/server/moderation/nudity");
    expect(first.nudityClassifierReady()).toBe(false);

    // What the warm does on completion, without paying for a 74 MB load.
    first.setNudityClassifierReadyForTest(true);

    vi.resetModules();
    const second = await import("@/server/moderation/nudity");

    expect(second.nudityClassifierReady()).toBe(true);
  });
});
