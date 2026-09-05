# A Message's Sequence crosses the wire as a string

Every payload leaving the server carries a Message's Sequence as a decimal string, never a JSON
number. Clients compare Sequences through a single comparison helper rather than with `<` or
`Math.max`.

The Sequence is a Postgres `BIGSERIAL`, a 64-bit integer. JSON has no integer type — every
number is a double, exact only to 2^53 — and `JSON.stringify` throws outright on a JavaScript
`BigInt`, so the value cannot simply be passed through as-is.

## Considered Options

**JSON number** — rejected, though not for the overflow. Reaching 2^53 would take roughly nine
quadrillion sends, which this system will not do. It was rejected because of what it permits
_before_ that point: a Sequence that looks like a number invites `a.seq < b.seq` and
`Math.max(...)` scattered through client code. Reconnect sync (#7) depends on the client
reporting the highest Sequence it holds, and that arithmetic is correct at every scale this
system reaches — so the ceiling is never the thing that fails a test. The cost is not a wrong
answer; it is comparison logic spread across the client with no single place to make correct.

**Branded string type** — rejected as premature. A distinct `Seq` type would make misuse a
compile error rather than a convention, but it requires a constructor call at every boundary
and buys nothing the helper does not, until there are enough call sites for the convention to
drift. Worth revisiting if it does.

## Consequences

Ordering cannot be done inline on the client. A Sequence comparison goes through one helper,
which is where the reconnect gap-filling logic in #7 has to be right — one place rather than
every call site. This is the point of the decision, not a side effect.

Sorting a page of Messages client-side needs that helper rather than a bare numeric subtract,
and a Sequence read from a payload must not be handed to arithmetic. Being a string is what
makes the mistake visible: `"10" < "9"` is wrong in an obvious, immediately-failing way, where
a silently-rounded number is wrong in an invisible one.

The server continues to hold the Sequence as a `bigint` throughout — the string exists only at
the serialization boundary, so `readMessages` and the pagination cursor keep working on the
real integer type.
