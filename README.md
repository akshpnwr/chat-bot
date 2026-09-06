# Chat

A real-time one-to-one messaging system. Messages are delivered over a persistent socket,
moderated server-side before they become visible, and survive disconnection without loss or
duplication.

- **Live deployment:** _not yet provisioned — see [Deployment](#deployment)_
- **Demo accounts:** [below](#demo-accounts)
- **Domain language:** [`CONTEXT.md`](CONTEXT.md) — the vocabulary this README uses
- **Decisions:** [`docs/adr/`](docs/adr) — nine records, each naming what was rejected and why

---

## Demo accounts

Three seeded accounts. Sign in as two of them in two browsers (or one browser and one private
window) to see both sides of a Conversation at once.

| Email | Password | Notes |
| --- | --- | --- |
| `ada@example.com` | `demo-password-1` | Short thread with Grace; 10,000-message thread with Alan |
| `grace@example.com` | `demo-password-2` | The other side of the short thread |
| `alan@example.com` | `demo-password-3` | The other side of the 10,000-message thread |

Ada ↔ Alan is seeded with **10,000 Messages** of varying length, so the virtualized list can be
judged at the size the requirement names rather than taken on trust.

These are demo credentials for a review deployment holding no real data. They are published
deliberately, and are the reason the deployment should not be treated as private.

---

## Architecture

### Runtime shape

**One long-lived Node process** serves both the Next.js application and the Socket.IO server on
a single HTTP server and a single origin ([`server/main.ts`](server/main.ts)).

```
                 ┌──────────────────────────────────────────────┐
   browser ──────┤  node process  (Render, free tier, 512 MB)   │
     │  HTTP     │                                              │
     │  ────────▶│   Next.js app + API routes                   │
     │           │                                              │
     │  WebSocket│   Socket.IO  ── presence, typing, delivery    │
     │  ────────▶│                                              │
     │           │   in memory: presence, typing, Allowances,   │
     │           │              NSFW classifier (~121 MB)       │
     └───────────┤                                              │
                 └───────┬───────────────────────┬──────────────┘
                         │                       │
                   Postgres (Neon)         Object storage
                   messages, read marks    quarantined → promoted
```

Sharing one process is what lets presence, typing state, rate-limit counters and the in-process
NSFW classifier live alongside the application rather than behind a network hop. That choice, and
the platforms rejected for it, is [ADR-0001](docs/adr/0001-single-node-process-on-render.md).

### Data model

Four domain tables — `User`, `Conversation`, `Participant`, `Message` — plus better-auth's
session tables. The shapes that carry the guarantees:

- **`Conversation.pairKey`** — the two user ids, sorted and joined, `@unique`. A pair yields the
  same key whichever side opens the thread, so "never more than one Conversation per pair" is
  enforced by a constraint rather than by a read-then-write check two concurrent opens could both
  pass.
- **`Message.seq`** — a global `BIGSERIAL`. One number is simultaneously the sort key, the
  pagination cursor, the Sync Cursor used for reconnect gap-filling, and the value a Read Mark
  holds ([ADR-0002](docs/adr/0002-monotonic-sequence-as-universal-cursor.md)). Three requirements
  collapse into one index, `(conversationId, seq DESC)`.
- **`Message.clientMessageId`** — `@@unique([conversationId, clientMessageId])`. This constraint
  _is_ the idempotency guarantee; the retry path relies on the database arbitrating, not on the
  server checking first.
- **`Participant.lastReadSeq`** — the Read Mark, monotonic. Unread Counts are derived from it and
  never stored.

### Key technical decisions

Each links to the record that names the alternatives and why they lost.

| Decision | Why |
| --- | --- |
| [Single Node process on Render](docs/adr/0001-single-node-process-on-render.md) | Serverless cannot hold WebSockets or an in-process model. Vercel, Cloudflare Workers, Railway and Fly all rejected, each for a stated reason. |
| [Sequence as universal cursor](docs/adr/0002-monotonic-sequence-as-universal-cursor.md) | A timestamp ties within a millisecond, and a tie on a page boundary silently drops or duplicates a Message. |
| [Moderation gates visibility, not delivery](docs/adr/0003-moderation-gates-visibility-not-delivery.md) | Filtering in the read model means a socket-layer bug cannot leak a Refused image through pagination or sync. |
| [Hand-rolled profanity pipeline](docs/adr/0004-hand-rolled-profanity-pipeline.md) | The pipeline is the deliverable; importing one would hide the work being assessed. |
| [shadcn shell, hand-rolled message list](docs/adr/0005-shadcn-for-shell-handrolled-message-list.md) | No shadcn component covers virtualization with dynamic measurement; wrapper cost lands in the one hot path. |
| [Sequence crosses the wire as a string](docs/adr/0006-sequence-crosses-the-wire-as-a-string.md) | A 64-bit integer has no JSON representation, and a number-shaped Sequence invites `<` and `Math.max` scattered across the client. |
| [NSFW inference on the WASM backend](docs/adr/0007-nsfw-inference-on-the-wasm-backend.md) | `tfjs-node`'s prebuilt binaries 404 on every napi version; WASM fits in 512 MB, measured. |
| [In-memory per-user rate limiting](docs/adr/0008-in-memory-per-user-rate-limiting.md) | Behind a proxy, an address-keyed limit is either one bucket for the internet or a header the client writes. |
| [Sniff content type in the pipeline](docs/adr/0009-sniff-content-in-the-moderation-pipeline.md) | The upload route has no bytes to sniff; the pipeline already holds the buffer. |

### Reliability

The properties the system promises, and where they are enforced:

- **A Message is never lost past Acceptance.** Sends are queued in a client-side outbox and
  retried until acknowledged. A Message sent while disconnected is delivered on reconnect.
- **A Message is never duplicated.** Every send carries a Client Message Id generated before it
  leaves the browser; the unique constraint means the same id sent twice yields one Message.
- **A reconnecting client misses nothing.** The client reports the highest Sequence it holds as a
  Sync Cursor, and the server returns only Messages after it.
- **Multi-tab is coherent.** Presence is derived from live connections, so a user with three tabs
  is online until the last one closes.

---

## Moderation

Two independent paths. Both run **server-side**, before a Message can reach its recipient — the
client is never the check.

### Text — synchronous, sub-millisecond

A hand-curated wordlist run through a normalization pipeline
([ADR-0004](docs/adr/0004-hand-rolled-profanity-pipeline.md)): lowercase → strip diacritics → map
leetspeak → collapse separators → collapse repeated characters (`fuuuck` → `fuck`). Then three
matching passes — whole word, the words run together, and the same allowing one skipped letter at
each join.

Because it is fast, text is checked inline and a Refused Message is never stored. The sender is
told which term tripped it; the recipient never learns the Message was attempted.

### Images — asynchronous, in-process inference

| | |
| --- | --- |
| **Model** | nsfwjs 4.4.0, MobileNetV2 graph model at 224×224 |
| **Where inference runs** | In the application process, on `@tensorflow/tfjs`'s **WASM** backend — no network call, no third-party service |
| **Approximate size** | **~121 MB** resident (backend + model) over a 46.7 MB baseline; ~167 MB peak during inference, inside Render's 512 MB |
| **Expected latency** | **~49 ms** mean over 20 classifications |
| **Loaded** | Once at startup, after `listen`, and reused — never per image |

Measured by [`scripts/nsfw-memory-spike.mjs`](scripts/nsfw-memory-spike.mjs), kept in the repo so
the numbers can be re-taken rather than trusted from this file.

**The threshold rule.** The model returns five class probabilities. An image is refused when:

```
Porn + Hentai >= 0.60     or     Sexy >= 0.80
```

Both comparisons are inclusive, so a score landing exactly on a threshold is refused.

`Porn` and `Hentai` are summed rather than thresholded separately because they are the model's
photographic and drawn readings of the same thing: an image split 0.4/0.4 is 80% explicit by the
model's own reckoning while clearing any per-class bar of 0.6. `Sexy` is held to a much higher bar
because the class covers swimwear and athletic photography, where a moderate score is ordinary
rather than a signal. The rule lives in
[`src/server/moderation/nudity-rule.ts`](src/server/moderation/nudity-rule.ts), apart from the
classifier, so it is tested against stated vectors in milliseconds.

**Why images are asynchronous.** 49 ms is too long to hold a send's acknowledgement open, so an
image Message is Accepted as `PENDING`, classified, then transitioned to `VISIBLE` and broadcast —
or to `REJECTED` and never broadcast
([ADR-0003](docs/adr/0003-moderation-gates-visibility-not-delivery.md)). Recipient-facing queries
filter on `status = 'VISIBLE'`, so the filter is in the read model rather than only in the
broadcast path: a bug in the socket layer cannot leak a Refused image through pagination or sync.

**Quarantine.** An uploaded object lands under a quarantine prefix and leaves it only by being
promoted after passing moderation, or discarded after not. The prefix — not a column — is what
makes the set of reachable objects exactly the set that cleared. A file's real type is settled
from its leading bytes inside the pipeline, never from the Declared Type the uploader claimed
([ADR-0009](docs/adr/0009-sniff-content-in-the-moderation-pipeline.md)).

---

## Security

Rate limits are held in process memory, in a sliding window, keyed on an identity the **server**
established rather than one the client supplied
([ADR-0008](docs/adr/0008-in-memory-per-user-rate-limiting.md)).

| Action | Allowance | Keyed on |
| --- | --- | --- |
| Sending a Message (text, image, GIF or sticker) | 30 per 10s | user id |
| Requesting an upload URL | 10 per 60s | user id |
| Failed sign-in | 5 per 5 min | email address |

Sending is the most generous deliberately: a reconnection retries every unacknowledged Message in
the outbox at once, and a limit that refused those would break the reliability guarantee in the
name of abuse. Spending an Allowance **defers** a Message rather than Refusing it — the client
waits out the stated interval and resends under the original Client Message Id.

Sign-in is keyed on the email address because there is no session yet, and **only failures count**:
the attempt is consumed before the password is verified and released if a session comes back. So
verification is never paid for during a flood, and someone signing into their own account correctly
never approaches the limit.

Also: uploads go straight to object storage under a presigned URL, so a large file never occupies a
request handler in the 512 MB process. The GIF provider's key stays server-side behind a proxy
route.

---

## Running locally

### Prerequisites

Node 22+ and a Postgres database. [Neon](https://neon.tech)'s free tier is what the deployment
targets; any Postgres works.

### Setup

```bash
git clone <this repo>
cd chat-bot
npm install
```

Copy [`.env.example`](.env.example) to `.env.local` and fill it in — it documents every variable
with the reasoning behind it:

```bash
cp .env.example .env.local
```

What each group is for:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` / `DIRECT_URL` | yes | Pooled URL for runtime queries; direct URL for migrations |
| `BETTER_AUTH_SECRET` | yes | Session signing key — `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | yes | The app's own origin (`http://localhost:3000` locally) |
| `STORAGE_*` | yes, for images | S3-compatible bucket; uploads go browser-to-bucket, never through the app server |
| `TEST_DATABASE_URL` / `TEST_DIRECT_URL` | for `npm test` | A **disposable** branch — the suite truncates it |
| `GIFS_API_KEY` | no | Unset is a supported state: the GIF tab reports itself unavailable and stickers still work |

Then:

```bash
npm run db:deploy    # apply migrations
npm run db:seed      # three demo accounts + a 10,000-message thread
npm run dev          # http://localhost:3000
```

Sign in as two of the demo accounts in two browsers to see both sides of a Conversation.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Custom server (Next + Socket.IO) with watch |
| `npm run build` | Next build, then compile the server, then copy the resolve hook |
| `npm start` | Production server from `dist/` |
| `npm run typecheck` | `tsc --noEmit` over both the app and the server |
| `npm test` | Integration suite against a real Postgres branch |
| `npm run test:browser` | Browser-driven reconnection suite (see caveat below) |
| `npm run db:seed` | Seed demo accounts and threads |

### Tests

`npm test` runs the integration suite against a real Postgres branch rather than a mocked client —
the guarantees under test (a unique constraint arbitrating idempotency, a `BIGSERIAL` producing
contiguous pages) live in the database, and a mock would pass while the real constraint broke. Set
`TEST_DATABASE_URL` and `TEST_DIRECT_URL` to a disposable branch; the suite truncates between
files.

`npm run test:browser` drives real browsers through reconnection scenarios. It is excluded from
`npm test` because it boots a server and runs against the development database. **Its harness is
not yet dependable** — three of nine scenarios pass consistently and the rest fail on harness and
environment problems rather than on application behaviour. Tracked as [#14](../../issues/14); the
product code it exercises is covered by unit tests.

---

## Deployment

> **Status: not yet provisioned.** The application is deployment-ready — it builds to a single
> process, reads all configuration from the environment, and exposes the health endpoint the
> keep-warm ping needs — but no public URL exists yet. The steps below are what provisioning
> requires.

Target is Render's free web-service tier with Postgres on Neon
([ADR-0001](docs/adr/0001-single-node-process-on-render.md)).

- **Build:** `npm install && npm run build`
- **Start:** `npm start`
- **Health check path:** `/api/health`
- **Environment:** every variable from [Setup](#setup), plus `PORT` (Render supplies it)

After the first deploy:

1. Run `npm run db:deploy` and `npm run db:seed` against the production database so the demo
   accounts exist.
2. Set the `DEPLOYMENT_URL` repository variable to the public URL — this arms
   [the keep-warm workflow](.github/workflows/keep-warm.yml), which stays skipped until it is set.
3. Put the URL at the top of this README, replacing the "not yet provisioned" note.

### Cold starts

Render's free tier **spins the service down after 15 minutes without traffic**, and waking it takes
roughly **60 seconds**. [`.github/workflows/keep-warm.yml`](.github/workflows/keep-warm.yml) pings
`/api/health` every 10 minutes so the idle window never elapses.

The workflow is committed but **inert until the deployment exists**: it skips unless the
`DEPLOYMENT_URL` repository variable is set, so it cannot fail against a service nobody has
provisioned yet. Setting that variable is the last step of [provisioning](#deployment).

A cron can still miss, so **if the first page load takes up to a minute, the service is cold
starting — not broken.** A second request lands on a warm process.

`/api/health` deliberately does **not** query Postgres. A database round trip on every ping would
keep Neon's branch awake as a side effect of a check that is about Render, and would turn a
transient database blip into a restart of a process that was serving fine. It reports uptime and
whether the classifier has finished loading:

```json
{ "status": "ok", "classifier": "ready", "uptimeSeconds": 3021 }
```

A `"loading"` classifier is healthy: the model loads a few seconds after the server starts
listening, and an image sent during that window is classified on demand rather than let through.

---

## Scope

### Single-instance constraints

Presence, typing state, rate-limit counters and the NSFW classifier all live in **this process's
memory**. That is the deliberate consequence of ADR-0001, and it is what running more than one
instance would break:

| State | What breaks at two instances | What it would take |
| --- | --- | --- |
| Socket delivery | Two users on different instances never see each other's Messages | Socket.IO Redis adapter |
| Presence | Each instance knows only its own connections, so a user looks offline to half the users | Shared presence store keyed on user id |
| Typing | Same — indicators only reach the instance the typist is on | Broadcast over the same adapter |
| Allowances | They multiply by the instance count; 30 per 10s becomes 60 per 10s at two | Shared counter store (Redis) |
| NSFW classifier | ~121 MB per instance rather than once | Unchanged, or a shared inference service |

Nothing in the data model blocks this — `seq`, `pairKey` and `clientMessageId` are all enforced by
Postgres and stay correct across any number of instances. The work is entirely in relocating
in-memory state, and the rate limiter's interface (`consume` / `release`) is deliberately narrow
enough to be backed by Redis without changing its callers.

### Deliberately out of scope

- **Group Conversations.** The domain fixes a Conversation at _exactly two_ participants, and
  `pairKey` encodes that in a unique constraint. Supporting groups is not a feature addition on top
  of this model — it would mean dropping `pairKey` for a different identity rule, rethinking what a
  Read Mark means when participants join mid-thread, and reworking unread counting. The requirement
  is one-to-one messaging, and modelling for groups that were not asked for would have cost the
  constraint that makes pair uniqueness a database guarantee.
- **Message editing and deletion.** A Message is immutable once Accepted, which is what lets `seq`
  be a stable cursor for pagination, sync and Read Marks alike.
- **Horizontal scaling.** Named above and costed; not built.
- **Push notifications, search, non-image attachments, threading, reactions.** None are in the
  requirement.

### Known gaps

- **No public deployment yet** — see [Deployment](#deployment). The keep-warm workflow is committed
  and waits on the `DEPLOYMENT_URL` variable; everything else needed to deploy is in place.
- **No screen recording yet** — the required demo capture (real-time messaging between two
  accounts, typing, presence, unread counts, GIFs and stickers, both moderation paths, and recovery
  from a disconnection) has not been recorded.
- **The browser-driven suite is not dependable** — [#14](../../issues/14).
