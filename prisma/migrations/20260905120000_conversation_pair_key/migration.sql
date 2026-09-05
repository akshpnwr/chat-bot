-- A Conversation's pair key: the two participants' user ids, sorted and joined.
-- The unique constraint is what enforces "never more than one Conversation for
-- a given pair", so two concurrent opens cannot both create one.

ALTER TABLE "conversation" ADD COLUMN "pairKey" TEXT;

-- Backfill existing rows from their Participants. Sorting the two ids means the
-- key does not depend on who opened the thread.
UPDATE "conversation" c
SET "pairKey" = sub.key
FROM (
  SELECT "conversationId", string_agg("userId", ':' ORDER BY "userId") AS key
  FROM "participant"
  GROUP BY "conversationId"
) sub
WHERE c.id = sub."conversationId";

-- Any Conversation with no Participants cannot be opened by anybody; give it a
-- unique placeholder so the NOT NULL and UNIQUE constraints below can apply.
UPDATE "conversation" SET "pairKey" = 'orphan:' || id WHERE "pairKey" IS NULL;

-- Collapse any pre-existing duplicates onto the oldest Conversation for a pair,
-- so the unique index can be created.
WITH ranked AS (
  SELECT id, "pairKey",
         ROW_NUMBER() OVER (PARTITION BY "pairKey" ORDER BY "createdAt", id) AS rn
  FROM "conversation"
)
DELETE FROM "conversation" WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

ALTER TABLE "conversation" ALTER COLUMN "pairKey" SET NOT NULL;

CREATE UNIQUE INDEX "conversation_pairKey_key" ON "conversation"("pairKey");
