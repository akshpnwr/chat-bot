# A file's real type is decided from its bytes, in the moderation pipeline

Whether an uploaded object is actually an image is settled by inspecting its leading bytes for a
known signature, and that inspection happens inside `moderateImageMessage`, immediately after the
object is read and before it is decoded or classified.

## Why the declared type cannot be the answer

The upload route checks the Declared Type before it signs a URL, and that check earns its place —
it refuses the obvious cases without spending any bandwidth. But it is a claim the uploader makes.
An executable renamed `cat.png` declares `image/png`, the route signs for `image/png`, and storage
records the object as `image/png`. From metadata alone nothing downstream can tell it apart from a
real PNG, because the claim was not merely trusted, it was written down.

## Why the pipeline is where it happens

The bytes never pass through the application server on the way in. That is deliberate and
load-bearing — the browser PUTs straight to object storage under a presigned URL so an 8 MB upload
never occupies a request handler in the 512 MB process that also holds a 121 MB classifier
(ADR-0001, ADR-0007). So the upload route is structurally incapable of sniffing: it has no bytes.

The moderation pipeline, on the other hand, already reads the object back in order to classify it.
Sniffing there costs one function call over a buffer that is already in hand: no second read of
the object, no extra round trip, and no change to the upload design.

The alternative considered was a verify endpoint the client calls after the PUT and before the
send. It was rejected for buying nothing: it would read the same object a second time and add a
round trip to every image send, and the refusal it produces would arrive a fraction of a second
before the one the pipeline already produces.

## Why before the decoder rather than instead of it

The sniff runs ahead of `decodeToTensor`, and both stay. They answer different questions and the
cheap one goes first:

- The signature check asks whether these bytes *begin* as one of the four accepted formats. It
  reads a dozen bytes.
- The decoder asks whether the rest of the file is a coherent image. It allocates.

Putting the cheap check first means a renamed executable is refused as what it is, having never
become an allocation in the process the model lives in. Without it, the same file would surface as
a decode failure — which reaches the sender as "could not be checked", a message that invites them
to retry the identical file forever.

The signature list is an allowlist for the same reason the upload rules are (`upload-rules.ts`):
a format is excluded by not being named. SVG fails it by having no binary signature at all, which
is the correct outcome — it is markup a browser will render and script, and no classifier can look
at it.

WebP is matched as two runs with four wildcards between them rather than on its `RIFF` prefix,
because `RIFF` alone is a container tag shared with WAV and AVI. Matching the prefix would call a
sound file a WebP.

## Consequences

A refusal for not being an image names its own reason, distinct from both an explicit image and
an undecidable one. All three end in the same place — a REJECTED Message that reaches its sender
and never its recipient (ADR-0003) — but a sender told the wrong one of the three is either
accused of something they did not do or advised to retry something that will never work.

This is a signature check, not a validation. A file that begins with a PNG signature and continues
as anything at all passes it, and is then refused by the decoder if it is not decodable. Two cheap
checks in front of one expensive one, each of which fails closed.

Sniffing after the object has landed means a non-image does briefly occupy space in the bucket. It
is discarded on refusal, in the same path that discards an explicit image, so the litter is
bounded by the upload rate limit (ADR-0008) rather than unbounded.
