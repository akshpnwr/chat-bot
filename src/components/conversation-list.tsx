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
 * Past this, the badge reads "99+" rather than growing without bound. A badge
 * wide enough for four digits would push the Participant's name out of a row
 * that is already tight on a phone.
 */
const UNREAD_DISPLAY_CAP = 99;

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
  onlineUserIds,
}: {
  conversations: WireConversation[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  /**
   * Who is online right now. Passed in rather than read from each row, because
   * Presence is a property of a User rather than of a Conversation -- the same
   * person is online in every Conversation they appear in, or in none.
   */
  onlineUserIds: ReadonlySet<string>;
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
        const online = onlineUserIds.has(conversation.otherParticipant.id);
        const unread = conversation.unreadCount;
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
              <span className="relative shrink-0">
                <span
                  className="bg-recessed text-secondary flex size-9 items-center justify-center rounded-full text-[12px]"
                  aria-hidden
                >
                  {initials(conversation.otherParticipant.name)}
                </span>
                {/* Status as a small dot, never a background fill (DESIGN.md §2).
                    Rendered only when online: an "offline" dot on every row is
                    noise, since offline is the resting state of most rows. */}
                {online ? (
                  <span
                    className="bg-status-green absolute right-0 bottom-0 size-2.5 rounded-full shadow-[0_0_0_2px_var(--color-background)]"
                    aria-hidden
                  />
                ) : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] leading-5">
                  {conversation.otherParticipant.name}
                  {/* The presence dot is decorative, so the fact it encodes is
                      given to a screen reader in words instead. */}
                  <span className="sr-only">{online ? " (online)" : " (offline)"}</span>
                </span>
                <span
                  className={cn(
                    "truncate text-[12px] leading-4",
                    // An unread Conversation's preview is the thing the reader
                    // is being pointed at, so it stops being muted.
                    unread > 0 ? "text-foreground" : "text-muted",
                  )}
                >
                  {/*
                    A picture is named rather than previewed. An image has no
                    body at all, so a Conversation whose last Message was a
                    photo would otherwise read "No messages yet", which is
                    false. A GIF and a sticker do carry a body -- the
                    provider's description and the pack's label -- but those
                    are alt text rather than something the sender wrote, and a
                    row reading "a dancing cat" would look like they said it.
                  */}
                  {conversation.latestMessage === null
                    ? "No messages yet"
                    : conversation.latestMessage.kind === "IMAGE"
                      ? "Photo"
                      : conversation.latestMessage.kind === "GIF"
                        ? "GIF"
                        : conversation.latestMessage.kind === "STICKER"
                          ? "Sticker"
                          : (conversation.latestMessage.body ?? "No messages yet")}
                </span>
              </span>
              {/*
                Count as weight and contrast rather than as a coloured fill.
                DESIGN.md reserves colour for interactive elements and for
                ~10px status dots -- a blue pill here would be the largest
                swatch of colour on the screen, drawing more attention than the
                Conversation it is attached to.
              */}
              {unread > 0 ? (
                <span
                  className="bg-foreground text-elevated flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] leading-none tabular-nums"
                  aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
                >
                  {unread > UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : unread}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
