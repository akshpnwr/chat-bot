"use client";

import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/connection-badge";
import { useSocket } from "@/lib/use-socket";

export default function Home() {
  const { socket, status } = useSocket();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col gap-6 px-4 py-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[32px] leading-10 tracking-[-1.28px] sm:text-[48px] sm:leading-[48px] sm:tracking-[-2.28px]">
          Chat
        </h1>
        <ConnectionBadge status={status} />
      </header>

      <p className="max-w-prose text-[16px] text-secondary">
        A real-time one-to-one messaging system. Messages are delivered over a
        persistent socket, moderated server-side before they become visible, and
        survive disconnection without loss or duplication.
      </p>

      <div className="rounded-card bg-elevated shadow-border-small flex flex-col gap-4 p-6">
        <h2>Socket</h2>
        <p className="text-[12px] leading-4 text-muted">
          The browser holds a socket to the same origin as the page — one Node
          process serves both.
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={!socket || status !== "connected"}
            onClick={() =>
              socket?.emit("ping", (reply) =>
                console.log("pong", new Date(reply.at).toISOString()),
              )
            }
          >
            Send a ping
          </Button>
        </div>
      </div>
    </main>
  );
}
