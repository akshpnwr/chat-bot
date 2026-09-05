"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionBadge } from "@/components/connection-badge";
import { ConversationList } from "@/components/conversation-list";
import { Composer } from "@/components/composer";
import { MessageList } from "@/components/message-list";
import { signOut } from "@/lib/auth-client";
import { useSocket } from "@/lib/use-socket";
import { useConversation } from "@/lib/use-conversation";
import type { WireConversation } from "@/lib/wire";
import { cn } from "@/lib/utils";

/** A burst of Messages costs one list refresh rather than one refresh each. */
const LIST_REFRESH_COALESCE_MS = 300;

/**
 * The main screen: a list of Conversations beside the open one.
 *
 * At narrow widths the two are one column rather than two -- the list is the
 * screen until a Conversation is opened, and the open Conversation replaces
 * it. A sidebar squeezed onto a phone would leave neither surface usable.
 */
export function ConversationView({
  viewerId,
  viewerName,
  conversations,
}: {
  viewerId: string;
  viewerName: string;
  conversations: WireConversation[];
}) {
  const router = useRouter();
  const { socket, status } = useSocket();
  const [selectedId, setSelectedId] = useState<string | null>(
    conversations[0]?.id ?? null,
  );
  const conversation = useConversation(socket, selectedId, viewerId);

  const selected = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  // The list is rendered on the server, so a Message arriving while the page is
  // open would leave its preview stale. Refreshing on delivery re-runs the
  // server component rather than keeping a second copy of the list's ordering
  // rules on the client.
  useEffect(() => {
    if (!socket) return;
    const onMessage = () => router.refresh();
    socket.on("message:new", onMessage);
    return () => {
      socket.off("message:new", onMessage);
    };
  }, [socket, router]);

  return (
    <div className="flex h-dvh w-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-4 py-3 shadow-[0_1px_0_0_rgb(0_0_0/0.08)] sm:px-6">
        <div className="flex items-center gap-3">
          {/* On a phone the open Conversation fills the screen, so the way back to the
              list has to be in the header rather than beside it. */}
          {selectedId ? (
            <Button
              variant="ghost"
              size="sm"
              className="sm:hidden"
              onClick={() => setSelectedId(null)}
              aria-label="Back to conversations"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </Button>
          ) : null}
          <h2 className="text-[14px] leading-5">{viewerName}</h2>
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

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "w-full shrink-0 overflow-y-auto sm:w-[300px] sm:shadow-[1px_0_0_0_rgb(0_0_0/0.08)]",
            selectedId ? "hidden sm:block" : "block",
          )}
          aria-label="Conversations"
        >
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>

        <section
          className={cn(
            "min-w-0 flex-1 flex-col",
            selectedId ? "flex" : "hidden sm:flex",
          )}
        >
          {selected === null ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-[12px] leading-4 text-muted">
                Select a conversation to start reading.
              </p>
            </div>
          ) : (
            <>
              <div className="shrink-0 px-4 py-3 shadow-[0_1px_0_0_rgb(0_0_0/0.08)] sm:px-6">
                <h2>{selected.otherParticipant.name}</h2>
              </div>

              {conversation.error ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <p className="text-[12px] leading-4 text-status-red">{conversation.error}</p>
                </div>
              ) : conversation.loading ? (
                <div className="flex flex-1 flex-col justify-end gap-3 p-4 sm:p-6" aria-busy>
                  {[0, 1, 2, 3].map((row) => (
                    <div
                      key={row}
                      className={cn(
                        "bg-recessed h-10 animate-pulse rounded-[12px]",
                        row % 2 === 0 ? "w-[45%]" : "ml-auto w-[35%]",
                      )}
                    />
                  ))}
                </div>
              ) : conversation.state.entries.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <p className="text-[12px] leading-4 text-muted">
                    No messages yet. Say hello.
                  </p>
                </div>
              ) : (
                <MessageList
                  entries={conversation.state.entries}
                  viewerId={viewerId}
                  onLoadOlder={conversation.loadOlder}
                  loadingOlder={conversation.loadingOlder}
                  reachedStart={conversation.state.reachedStart}
                />
              )}

              <div className="shrink-0 shadow-[0_-1px_0_0_rgb(0_0_0/0.08)]">
                <Composer onSend={conversation.send} disabled={status !== "connected"} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
