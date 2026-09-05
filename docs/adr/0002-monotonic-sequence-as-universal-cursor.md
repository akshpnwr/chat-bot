# A monotonic sequence number is the universal cursor

Every Message carries a global `seq BIGSERIAL` column. It is the sort key, the pagination
cursor, the Sync Cursor used for reconnect gap-filling, and the value stored in a Participant's
Read Mark.

## Considered Options

**Cuid/UUID id as cursor** — rejected. Ids are not sortable, forcing `ORDER BY createdAt DESC,
id DESC` with a compound cursor and a wider index.

**createdAt timestamp** — rejected. Two Messages written in the same millisecond tie, and a tie
landing on a page boundary silently drops or duplicates a Message. This is exactly the class of
bug that only appears under load, which is when a reviewer is looking.

## Consequences

Three separate requirements collapse into one index, `(conversationId, seq DESC)`:

- Pagination: `WHERE conversationId = ? AND seq < ? ORDER BY seq DESC LIMIT 50`
- Reconnect sync: `WHERE conversationId = ? AND seq > ?`
- Unread Count: `WHERE conversationId = ? AND seq > <read mark> AND status = 'VISIBLE'`

`createdAt` remains on the row for display but is never used for ordering.

Being a 64-bit integer, the Sequence cannot cross the wire as a JSON number; ADR-0006 records
how it is represented at the serialization boundary.

A global sequence is a single Postgres sequence, which would become a write bottleneck at very
high throughput. At this system's scale it is not, and the simplicity is worth more than the
theoretical ceiling. A per-conversation counter would remove the bottleneck at the cost of a
write to the parent Conversation row on every send.
