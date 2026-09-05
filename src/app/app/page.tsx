import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listConversations } from "@/server/conversations";
import { toWireConversation } from "@/lib/wire";
import { ConversationView } from "./conversation-view";

export default async function AppPage() {
  // Verified server-side on every request; a signed-out visitor never sees the
  // authenticated view at all.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/sign-in");
  }

  const conversations = await listConversations(session.user.id);

  return (
    <ConversationView
      viewerId={session.user.id}
      viewerName={session.user.name}
      // Serialized at the boundary (ADR-0006): a Sequence cannot cross into a
      // client component as a bigint.
      conversations={conversations.map(toWireConversation)}
    />
  );
}
