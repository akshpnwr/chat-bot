# Moderation gates visibility in the read model, not just the broadcast

An image Message is written with `status: PENDING`, moderated, and only then transitioned to
`VISIBLE` and broadcast to the recipient. A rejected Message becomes `REJECTED` and is never
broadcast. All recipient-facing queries filter on `status = 'VISIBLE'`.

The important part is that the filter lives in the read model rather than only in the broadcast
path. Gating delivery alone would mean a single bug in the socket layer leaks a rejected image;
gating the query means the recipient cannot retrieve it by any route, including pagination and
reconnect sync. Visibility and authorization are enforced in the same place.

## Consequences

The sender sees their own PENDING Message with a spinner and, on failure, a clear moderation
reason. The recipient never learns a blocked Message existed — which is the intended reading of
"rejected before delivery".

Text Messages skip PENDING and are written VISIBLE, because profanity checking is synchronous
and sub-millisecond. Only images take the asynchronous path.
