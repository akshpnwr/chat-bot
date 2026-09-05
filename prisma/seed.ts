import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

const { prisma } = await import("../src/lib/db.js");
const { auth } = await import("../src/lib/auth.js");

/**
 * Demo accounts published in the README so a reviewer can sign in as two
 * different users within a minute of opening the deployment.
 */
export const DEMO_USERS = [
  { email: "ada@example.com", name: "Ada Lovelace", password: "demo-password-1" },
  { email: "grace@example.com", name: "Grace Hopper", password: "demo-password-2" },
] as const;

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
    console.log(`[seed] user ${spec.email} has no credential — recreating`);
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
 * Reuses the existing Conversation for a pair rather than creating a second
 * one -- there is never more than one Conversation for a given pair.
 */
async function ensureConversation(userAId: string, userBId: string) {
  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [
        { participants: { some: { userId: userAId } } },
        { participants: { some: { userId: userBId } } },
      ],
    },
  });
  if (existing) {
    console.log(`[seed] conversation exists: ${existing.id}`);
    return existing;
  }

  const conversation = await prisma.conversation.create({
    data: {
      participants: {
        create: [{ userId: userAId }, { userId: userBId }],
      },
    },
  });
  console.log(`[seed] created conversation: ${conversation.id}`);
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

async function main() {
  const users = [];
  for (const spec of DEMO_USERS) {
    users.push(await ensureUser(spec));
  }

  const [ada, grace] = users;
  if (!ada || !grace) throw new Error("Expected two demo users");

  await pruneOrphanedConversations();
  const conversation = await ensureConversation(ada.id, grace.id);

  // A couple of Messages so an opened thread is not empty on first look.
  const seedMessages = [
    { senderId: ada.id, body: "Hey Grace â€” this thread is seeded.", key: "seed-1" },
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
