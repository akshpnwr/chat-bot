# In-memory rate limiting, keyed on the user rather than the address

Rate limits are held in the application process's own memory, in a sliding-window counter per
key, and every key is an identity the server established rather than one the client supplied.
Nothing is written to Postgres and there is no Redis.

## Keyed on the user, not the address

The deployment is a single Node process behind Render's proxy (ADR-0001). Every request therefore
arrives from the proxy's address, which leaves two options for an address-keyed limit, and both
are worse than useless:

- Limit on the observed address, and the whole internet shares one bucket. The first person to
  flood refuses everybody.
- Limit on `X-Forwarded-For`, and the limit is bypassed by setting a header. A client that can
  choose its own key does not have a limit.

The session's user id has neither problem. It is established server-side — from the cookie in an
HTTP route, and at the handshake for a socket (`server/socket.ts`) — so it cannot be claimed, and
it is per-account, so one abuser's flood costs only that account. It is the same property the
whole authorization story already rests on, reused rather than reinvented.

Sign-in is the one exception, and it has to be: there is no session yet. It is keyed on the email
address, which is what an attacker holds fixed while varying the password.

## Only failures count against sign-in

The throttle consumes an attempt *before* the password is verified and releases it again if a
session comes back. Two things follow. Verification is deliberately expensive, so a flood is
refused without ever paying for the hashing — which is the resource being protected. And somebody
signing into their own account correctly, however often, never approaches the limit: this is a
throttle on guessing, not a lockout on use.

A refused attempt is never itself recorded, for the same reason. Recording refusals would let a
client that retries steadily push the window's oldest entry forward forever and never be
readmitted — turning a limit into a permanent lockout, and punishing exactly the client that
backs off least.

## A sliding window rather than a fixed one

A fixed window resets on a boundary, so a caller who spends their whole allowance just before it
can spend it again immediately after: twice the limit across the boundary, which is the exact
burst a limit exists to prevent. A sliding window has no boundary to straddle — what counts is
always the last `windowMs`.

The cost is a timestamp per attempt instead of one integer per key. That is affordable only
because the limits are small: a bucket holds at most `limit` entries, since a caller at the limit
is refused and refusals are not recorded. Buckets are swept on read, so a key whose attempts have
all aged out is forgotten rather than held for the life of the process.

## The limits

| Action | Allowance | Keyed on |
| --- | --- | --- |
| Sending a Message (text, image, GIF or sticker) | 30 per 10s | user id |
| Requesting an upload URL | 10 per 60s | user id |
| Failed sign-in | 5 per 5min | email address |

Sending is the most generous, and that is not slack. A reconnection retries every unacknowledged
Message in the outbox at once, and a limit that refused those would break the reliability
guarantee in the name of abuse — the sender would be told their Messages were retried while they
sat unsent. Uploading is the tightest, because each upload buys the sender an object in the
bucket and an inference on the WASM backend (ADR-0007) inside 512 MB.

All four send events share one allowance rather than holding one each. The resource being
protected is shared — a flood of stickers costs the process what a flood of text does — and four
separate allowances would let a script spend all of them at once for four times the traffic.

## Being refused is a thing the client can act on

Every refusal names when to come back, because a client that is only told "no" can only guess, and
a guessing client retries immediately — which is the hammering the limit exists to stop. Each
transport spells that in its own idiom: HTTP routes answer `429` with a `Retry-After` header, and
the socket answers with `RATE_LIMITED` and a `retryAfterMs`.

A rate-limited send stays in the outbox and is rendered as still pending. It is the one refusal
that becomes acceptance simply by waiting, so unlike prohibited language or a bad asset key it is
not dropped — the client waits out the stated interval and sends it again under the same Client
Message Id.

## Consequences

**The counters are per-process, and that is a real constraint, not a detail.** On a second
instance each process would hold its own counters, so the effective limit would be the configured
one multiplied by the instance count, and which instance a request landed on would decide whether
it was refused. Sign-in throttling degrades worst: an attacker who reconnects until they reach a
process that has not seen them gets a fresh allowance.

Horizontal scaling therefore requires moving the counters to shared storage — Redis, with the same
sliding-window shape, which is the same dependency ADR-0001 already names for the Socket.IO
adapter. The limiter's interface (`consume` / `release`) is deliberately narrow enough that it can
become asynchronous and Redis-backed without the call sites changing shape.

**Counters do not survive a restart.** A deploy resets every window, so an attacker mid-flood gets
a fresh allowance. Accepted: the alternative is a database write on the hot path of every single
send, which costs every well-behaved user latency to inconvenience an abuser for a few seconds
across a deploy.

**The limits are not tuned against real traffic.** They are set well above what the interface can
produce and well below what a script can, which is the right shape for the requirement; the
figures themselves are a starting point and live in one place (`RATE_LIMITS`) to be moved.
