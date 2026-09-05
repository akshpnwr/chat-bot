"use client";

import type { ConnectionStatus } from "@/lib/use-socket";
import { cn } from "@/lib/utils";

/**
 * What the badge actually reports, which is not quite the socket's status.
 *
 * Recovery is its own state rather than a fourth ConnectionStatus: the socket
 * is genuinely connected while missed Messages are being fetched, and a badge
 * claiming otherwise would contradict the composer, which is enabled at that
 * moment. Keeping the distinction here means the socket's status stays a
 * statement about the socket, and this file decides what the user is told.
 */
type BadgeState = ConnectionStatus | "syncing";

const LABEL: Record<BadgeState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  syncing: "Catching up",
};

/* Status as a ~10px dot only — never a background fill (DESIGN.md §2). */
const DOT: Record<BadgeState, string> = {
  connecting: "bg-status-orange",
  connected: "bg-status-green",
  disconnected: "bg-status-red",
  // Amber rather than green: connected, but what is on screen is not yet the
  // whole Conversation, and the dot should not say otherwise.
  syncing: "bg-status-orange",
};

/**
 * Whether the connection is live, and whether it is still catching up.
 *
 * Recovery is shown while it happens because it is the visible proof of the
 * guarantee -- a user who watched a Conversation go quiet during an outage
 * needs to see that the gap is being filled, not wonder whether the Messages
 * are simply gone.
 */
export function ConnectionBadge({
  status,
  syncing = false,
}: {
  status: ConnectionStatus;
  syncing?: boolean;
}) {
  // Syncing only overrides a live connection. While disconnected, being
  // disconnected is the more important thing to say.
  const state: BadgeState = status === "connected" && syncing ? "syncing" : status;

  return (
    <span
      className="inline-flex items-center gap-2 text-[12px] leading-4 text-secondary"
      role="status"
      aria-live="polite"
    >
      <span
        className={cn(
          "size-2.5 rounded-full",
          DOT[state],
          state === "syncing" && "animate-pulse",
        )}
        aria-hidden
      />
      {LABEL[state]}
    </span>
  );
}
