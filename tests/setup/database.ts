import { prisma } from "@/lib/db";

/**
 * Clears the domain tables between tests. Truncating the parent tables cascades
 * to Participant and Message, and restarting identity resets the Message
 * sequence so a test can reason about seq values from a known floor.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "message", "participant", "conversation", "session", "account", "user" RESTART IDENTITY CASCADE`,
  );
}

let userCounter = 0;

/** A User with an email unique to this run, so tests cannot collide. */
export async function createUser(name: string) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      name,
      email: `${name.toLowerCase().replace(/\W+/g, "-")}-${userCounter}-${Date.now()}@test.local`,
    },
  });
}
