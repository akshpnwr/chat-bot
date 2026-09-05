"use client";

import type { WireConversation } from "@/lib/wire";
import { cn } from "@/lib/utils";

/** The initials shown when a Participant has no avatar image. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The viewer's Conversations, most recently active first.
 *
 * Not virtualized, unlike the message list: a one-to-one system gives a User as
 * many Conversations as they have correspondents, which is a number that fits
 * on a screen. Virtualizing it would add machinery to a list that never gets
 * long enough to need it.
 */
export function ConversationList({
  conversations,
  selectedId,
  onSelect,
}: {
  conversations: WireConversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
}) {
  // No loading branch: the list is rendered on the server and arrives with the
  // page, so there is no moment at which it is present but empty of data.
  if (conversations.length === 0) {
    return (
      <p className="p-6 text-[12px] leading-4 text-muted">
        No conversations yet. Sign in as the other demo account to start one.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1 p-2">
      {conversations.map((conversation) => {
        const selected = conversation.id === selectedId;
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(conversation.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left transition-colors outline-none",
                "focus-visible:shadow-[0_0_0_2px_#fff,0_0_0_4px_var(--color-accent)]",
                selected ? "bg-hover" : "hover:bg-hover",
              )}
            >
              <span
                className="bg-recessed text-secondary flex size-9 shrink-0 items-center justify-center rounded-full text-[12px]"
                aria-hidden
              >
                {initials(conversation.otherParticipant.name)}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] leading-5">
                  {conversation.otherParticipant.name}
                </span>
                <span className="truncate text-[12px] leading-4 text-muted">
                  {conversation.latestMessage?.body ?? "No messages yet"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
