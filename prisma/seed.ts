import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const { prisma } = await import("../src/lib/db.js");
const { auth } = await import("../src/lib/auth.js");
const { openConversation } = await import("../src/server/conversations.js");

/**
 * Demo accounts published in the README so a reviewer can sign in as two
 * different users within a minute of opening the deployment.
 */
export const DEMO_USERS = [
  { email: "ada@example.com", name: "Ada Lovelace", password: "demo-password-1" },
  { email: "grace@example.com", name: "Grace Hopper", password: "demo-password-2" },
  // A third account so the bulk Conversation sits in its own thread, leaving
  // the Ada/Grace thread short enough to read.
  { email: "alan@example.com", name: "Alan Turing", password: "demo-password-3" },
] as const;

/**
 * How many Messages the bulk Conversation holds. The requirement is that a
 * Conversation of 10,000 opens and scrolls without stutter, so the seed
 * produces exactly that rather than a number a reviewer has to take on trust.
 */
const BULK_MESSAGE_COUNT = 10_000;

/**
 * Credentials are created through better-auth's own sign-up API rather than by
 * writing an Account row directly, so the stored hash always matches whatever
 * scheme better-auth currently uses.
 */
async function ensureUser(spec: (typeof DEMO_USERS)[number]) {
  const existing = await prisma.user.findUnique({
    where: { email: spec.email },
    include: { accounts: { where: { providerId: "credential" } } },
  });

  // A User row without a credential Account cannot sign in. That state is
  // reachable if a previous seed failed partway, so repair it rather than
  // reporting success on an account the reviewer cannot actually use.
  if (existing && existing.accounts.length > 0) {
    console.log(`[seed] user ready: ${spec.email}`);
    return existing;
  }
  if (existing) {
    console.log(`[seed] user ${spec.email} has no credential - recreating`);
    await prisma.user.delete({ where: { id: existing.id } });
  }

  await auth.api.signUpEmail({
    body: { email: spec.email, name: spec.name, password: spec.password },
  });

  const created = await prisma.user.findUnique({ where: { email: spec.email } });
  if (!created) throw new Error(`Failed to create demo user ${spec.email}`);
  console.log(`[seed] created user: ${spec.email}`);
  return created;
}

/**
 * Delegates to the message service so the seed creates a Conversation exactly
 * the way the application does -- pair key included -- rather than keeping a
 * second copy of the reuse rule that could drift from it.
 */
async function ensureConversation(userAId: string, userBId: string) {
  const conversation = await openConversation({
    userId: userAId,
    otherUserId: userBId,
  });
  console.log(`[seed] conversation ready: ${conversation.id}`);
  return conversation;
}

/**
 * A Conversation with fewer than two Participants cannot be opened by anybody.
 * Recreating a demo user cascades their Participant away and can leave one
 * behind, so clear them before reconciling.
 */
async function pruneOrphanedConversations() {
  const orphans = await prisma.conversation.findMany({
    where: { participants: { none: {} } },
    select: { id: true },
  });
  const singles = await prisma.conversation.findMany({
    select: { id: true, _count: { select: { participants: true } } },
  });
  const ids = [
    ...orphans.map((c) => c.id),
    ...singles.filter((c) => c._count.participants < 2).map((c) => c.id),
  ];
  if (ids.length === 0) return;
  await prisma.conversation.deleteMany({ where: { id: { in: ids } } });
  console.log(`[seed] pruned ${ids.length} conversation(s) with under two Participants`);
}

/**
 * Fills a Conversation to `BULK_MESSAGE_COUNT` Messages, so the virtualized
 * list can be judged against the size the requirement names.
 *
 * Written with createMany in batches rather than through sendMessage: the
 * service is the right path for one Message and the wrong one for ten thousand,
 * where a round trip each would take minutes. Idempotency still holds -- the
 * Client Message Ids are deterministic, and skipDuplicates leans on the same
 * unique constraint the service does, so re-running the seed tops the thread up
 * rather than doubling it.
 */
async function ensureBulkMessages(conversationId: string, senderIds: string[]) {
  const existing = await prisma.message.count({ where: { conversationId } });
  if (existing >= BULK_MESSAGE_COUNT) {
    console.log(`[seed] bulk conversation already holds ${existing} messages`);
    return;
  }

  const BATCH = 1_000;
  for (let start = existing; start < BULK_MESSAGE_COUNT; start += BATCH) {
    const rows = [];
    for (let index = start; index < Math.min(start + BATCH, BULK_MESSAGE_COUNT); index += 1) {
      rows.push({
        conversationId,
        senderId: senderIds[index % senderIds.length]!,
        // Varying length is the point: rows of uniform height would make the
        // virtualizer's dynamic measurement look correct without exercising it.
        body: `Message ${index + 1}. ${"Scrollback filler. ".repeat((index % 5) + 1)}`,
        clientMessageId: `bulk-${index}`,
      });
    }
    await prisma.message.createMany({ data: rows, skipDuplicates: true });
  }

  console.log(`[seed] bulk conversation filled to ${BULK_MESSAGE_COUNT} messages`);
}

async function main() {
  const users = [];
  for (const spec of DEMO_USERS) {
    users.push(await ensureUser(spec));
  }

  const [ada, grace, alan] = users;
  if (!ada || !grace || !alan) throw new Error("Expected three demo users");

  await pruneOrphanedConversations();
  const conversation = await ensureConversation(ada.id, grace.id);

  // A couple of Messages so an opened thread is not empty on first look.
  const seedMessages = [
    { senderId: ada.id, body: "Hey Grace — this thread is seeded.", key: "seed-1" },
    { senderId: grace.id, body: "Got it. Sequencing looks right.", key: "seed-2" },
  ];
  for (const m of seedMessages) {
    await prisma.message.upsert({
      where: {
        conversationId_clientMessageId: {
          conversationId: conversation.id,
          clientMessageId: m.key,
        },
      },
      update: {},
      create: {
        conversationId: conversation.id,
        senderId: m.senderId,
        body: m.body,
        clientMessageId: m.key,
      },
    });
  }

  const bulk = await ensureConversation(ada.id, alan.id);
  await ensureBulkMessages(bulk.id, [ada.id, alan.id]);

  console.log("[seed] done");
}

await main()
  .catch((error: unknown) => {
    console.error("[seed] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
