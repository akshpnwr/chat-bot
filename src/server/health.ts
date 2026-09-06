/**
 * What the health endpoint reports, decided apart from the runtime that
 * measures it.
 *
 * Split the same way the nudity rule is split from the classifier that feeds
 * it (`src/server/moderation/nudity-rule.ts`, ADR-0007): the readings come
 * from `process.uptime()` and the classifier, and what those readings *mean*
 * is decided here, where it can be stated in tests rather than arranged by
 * booting a server.
 */

/** The readings a report is made from. */
export interface HealthReadings {
  /** Seconds the process has been up, as `process.uptime()` gives it. */
  uptimeSeconds: number;
  /** Whether the nudity classifier has finished loading (ADR-0007). */
  classifierReady: boolean;
}

export interface HealthReport {
  status: "ok";
  /**
   * Reported rather than gating the status. The classifier loads after the
   * server is listening and takes a few seconds, and an image arriving before
   * it is ready is classified on demand rather than let through -- so a
   * loading model is a process that is working, not one to restart.
   */
  classifier: "ready" | "loading";
  /**
   * Whole seconds. What a reader wants from this is whether the process
   * cold-started on the ping they just sent, and fractions do not help answer
   * that.
   */
  uptimeSeconds: number;
}

/**
 * Rules on the process's health.
 *
 * The status is unconditionally `ok`, and that is the decision rather than an
 * omission. This endpoint is what an external cron pings every ten minutes to
 * hold off Render's idle spin-down (ADR-0001), and what the platform's own
 * health check reads. Anything reported unhealthy here is something the
 * platform may restart the process over, so the bar is "can this process serve
 * requests" -- and code reaching this function has already answered yes by
 * running.
 *
 * In particular it does not query Postgres. A database round trip on every
 * ping would keep Neon's branch awake as a side effect of a check that is
 * about Render, and it would turn a transient database blip into a restart of
 * a process that was serving perfectly well.
 */
export function healthReport(readings: HealthReadings): HealthReport {
  return {
    status: "ok",
    classifier: readings.classifierReady ? "ready" : "loading",
    uptimeSeconds: Math.floor(readings.uptimeSeconds),
  };
}
