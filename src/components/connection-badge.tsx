"use client";

import type { ConnectionStatus } from "@/lib/use-socket";
import { cn } from "@/lib/utils";

const LABEL: Record<ConnectionStatus, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
};

/* Status as a ~10px dot only — never a background fill (DESIGN.md §2). */
const DOT: Record<ConnectionStatus, string> = {
  connecting: "bg-status-orange",
  connected: "bg-status-green",
  disconnected: "bg-status-red",
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span
      className="inline-flex items-center gap-2 text-[12px] leading-4 text-secondary"
      role="status"
      aria-live="polite"
    >
      <span className={cn("size-2.5 rounded-full", DOT[status])} aria-hidden />
      {LABEL[status]}
    </span>
  );
}
