"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/connection-badge";
import { signOut } from "@/lib/auth-client";
import { useSocket } from "@/lib/use-socket";

/**
 * A placeholder authenticated view. It exists to prove the spine: the page is
 * reachable only when signed in, and the socket it opens is authenticated by
 * the same session cookie without the client asserting who it is.
 */
export function AuthenticatedView({
  userName,
  userEmail,
  conversationIds,
}: {
  userName: string;
  userEmail: string;
  conversationIds: string[];
}) {
  const router = useRouter();
  const { socket, status } = useSocket();
  const [socketUserId, setSocketUserId] = useState<string | null>(null);
  const [joined, setJoined] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!socket) return;
    const onReady = ({ userId }: { userId: string }) => setSocketUserId(userId);
    socket.on("connection:ready", onReady);
    return () => {
      socket.off("connection:ready", onReady);
    };
  }, [socket]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col gap-6 px-4 py-12 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[32px] leading-10 tracking-[-1.28px]">
            {userName}
          </h1>
          <p className="text-[12px] leading-4 text-muted">{userEmail}</p>
        </div>
        <div className="flex items-center gap-4">
          <ConnectionBadge status={status} />
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              await signOut();
              router.push("/sign-in");
              router.refresh();
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      <section className="rounded-card bg-elevated shadow-border-small flex flex-col gap-3 p-6">
        <h2>Socket identity</h2>
        <p className="text-[12px] leading-4 text-muted">
          The server established this from the session cookie at handshake time.
          The client never sent it.
        </p>
        <p className="font-mono text-[13px] leading-5">
          {socketUserId ?? "awaiting handshake…"}
        </p>
      </section>

      <section className="rounded-card bg-elevated shadow-border-small flex flex-col gap-3 p-6">
        <h2>Conversations</h2>
        {conversationIds.length === 0 ? (
          <p className="text-[12px] leading-4 text-muted">
            No Conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {conversationIds.map((id) => (
              <li key={id} className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-[13px] leading-5">{id}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={status !== "connected"}
                  onClick={() =>
                    socket?.emit("conversation:join", { conversationId: id }, (reply) =>
                      setJoined((prev) => ({
                        ...prev,
                        [id]: reply.ok ? "joined" : reply.error,
                      })),
                    )
                  }
                >
                  Join
                </Button>
                {joined[id] ? (
                  <span className="text-[12px] leading-4 text-secondary">
                    {joined[id]}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
