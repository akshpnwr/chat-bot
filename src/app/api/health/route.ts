import { NextResponse } from "next/server";
import { healthReport } from "@/server/health";
import { nudityClassifierReady } from "@/server/moderation/nudity";

/**
 * What an external cron pings to keep the deployment warm, and what the
 * platform reads to decide the process is alive.
 *
 * Render's free tier spins a service down after 15 minutes without traffic and
 * takes ~60s to come back (ADR-0001). A ping every ten minutes keeps the
 * window from ever elapsing; the README documents the cold start anyway, since
 * a cron can miss.
 *
 * Deliberately unauthenticated. It is pinged by a cron that holds no session,
 * and it discloses nothing an anonymous visitor could not learn by loading the
 * sign-in page.
 *
 * The route is thin on purpose: it takes the readings and hands them to
 * `healthReport`, which is where what they mean is decided and tested.
 */

/**
 * Never prerendered, and never served from a cache. A cached health response
 * would answer the keep-warm ping without the process doing any work, which is
 * exactly the work the ping exists to cause.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const report = healthReport({
    uptimeSeconds: process.uptime(),
    classifierReady: nudityClassifierReady(),
  });

  return NextResponse.json(report, {
    headers: { "cache-control": "no-store" },
  });
}
