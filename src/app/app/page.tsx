import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AuthenticatedView } from "./authenticated-view";

export default async function AppPage() {
  // Verified server-side on every request; a signed-out visitor never sees the
  // authenticated view at all.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }

  const participants = await prisma.participant.findMany({
    where: { userId: session.user.id },
    select: { conversationId: true },
  });

  return (
    <AuthenticatedView
      userName={session.user.name}
      userEmail={session.user.email}
      conversationIds={participants.map((p) => p.conversationId)}
    />
  );
}
