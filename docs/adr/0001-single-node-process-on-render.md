# Single long-lived Node process on Render, not serverless

The app is a real-time messaging system whose graded requirements include WebSocket
reconnection/idempotency behaviour and server-side NSFW image inference. We deploy a single
Node process that serves both the Next.js app and the Socket.IO server, hosted on Render's
free tier with Postgres on Neon.

## Considered Options

**Vercel** — rejected. Serverless functions cannot hold persistent WebSocket connections, so
the socket server, presence tracking, and the in-memory NSFWJS model all have nowhere to live.
Would have required delegating the realtime layer to a managed provider (Pusher/Ably), which
hands away the reconnect/dedup/idempotency protocol that the task grades directly.

**Cloudflare Workers + Durable Objects** — genuinely close, and rejected reluctantly. Durable
Objects with WebSocket Hibernation are an excellent fit for the messaging layer: one object per
conversation gives serialized execution and free idle connections. Rejected because
`@tensorflow/tfjs-node` is a native N-API binding that cannot run in a V8 isolate, and the free
plan's 10ms CPU limit per request makes NSFW inference infeasible regardless. Cloudflare
Containers would solve both but are paid-only ($5/mo). Choosing Cloudflare would have traded a
mandatory graded requirement (server-side moderation) for a convenience one.

**Railway / Fly.io** — rejected. Neither has a genuine free tier as of late 2026; both are
trial-credit models that stop the workload once credit is exhausted.

## Consequences

Render's free tier spins the service down after 15 minutes without traffic, with a ~60s cold
start. Mitigated by an external cron pinging a health endpoint every 10 minutes; the README
documents the cold-start possibility so it reads as a known trade-off rather than a fault.

Postgres is on Neon rather than Render's free Postgres, which expires 30 days after creation
and would silently kill the deployment mid-review. Neon is permanently free with no expiry.

Running a single instance means socket and presence state is in-process by design. Horizontal
scaling would require the Socket.IO Redis adapter; this is noted but deliberately not built.
