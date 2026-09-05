"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ConversationEntry } from "@/lib/conversation-state";
import { cn } from "@/lib/utils";

/**
 * How far from the top the reader must come before the next page is requested.
 * Fetching before the top is actually reached is what keeps the load invisible
 * -- by the time the reader would have run out of Messages, the next page is
 * already there.
 */
const LOAD_OLDER_THRESHOLD_PX = 400;

/** Within this distance of the bottom, a new Message scrolls into view. */
const PINNED_TO_BOTTOM_PX = 120;

/**
 * A conservative first guess at a row's height, replaced by a real measurement
 * as soon as the row mounts. Rows are variable-height by nature -- a one-word
 * Message and a paragraph are not the same size.
 */
const ESTIMATED_ROW_PX = 64;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The virtualized Conversation.
 *
 * Hand-built on TanStack Virtual rather than composed from shell components
 * (ADR-0005): dynamic row measurement and scroll anchoring are the hot path the
 * performance requirement measures, and wrapping each row in a Card would add
 * DOM depth to exactly the place that has to stay cheap at 10,000 Messages.
 *
 * Two scroll behaviours have to coexist here, and they pull in opposite
 * directions:
 *
 *  - New Messages should scroll into view, but only if the reader is already at
 *    the bottom. Yanking someone back down while they read history is worse
 *    than letting a Message arrive unseen.
 *  - Prepending an older page must not move what the reader is looking at.
 *    Rows are inserted above the viewport, so the scroll offset is corrected by
 *    the height that appeared -- the anchoring the ticket asks for. See the
 *    layout effect below for the bound on how exact that correction is.
 */
export function MessageList({
  entries,
  viewerId,
  onLoadOlder,
  loadingOlder,
  reachedStart,
}: {
  entries: ConversationEntry[];
  viewerId: string;
  onLoadOlder: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    // Rows are keyed by identity rather than index, so a prepended page does
    // not invalidate the measurements of rows that merely shifted down.
    getItemKey: (index) => entries[index]?.clientMessageId ?? index,
    overscan: 8,
  });

  const totalSize = virtualizer.getTotalSize();

  // Anchoring state, held in refs because the correction has to happen in the
  // same frame the new rows are laid out -- a re-render would be a visible jump.
  const previousTotalSize = useRef(0);
  const previousCount = useRef(0);
  const pinnedToBottom = useRef(true);

  const firstKey = useRef<string | null>(null);

  const isAtBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return true;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distance <= PINNED_TO_BOTTOM_PX;
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const currentFirstKey = entries[0]?.clientMessageId ?? null;
    // A page was prepended when the Conversation grew *and* the Message at the
    // top is a different one than before. A Message arriving at the bottom
    // grows it too but leaves the top alone -- distinguishing the two is what
    // decides whether to anchor or to follow.
    const prepended =
      previousCount.current > 0 &&
      entries.length > previousCount.current &&
      currentFirstKey !== firstKey.current;

    if (prepended) {
      // Everything the reader is looking at moved down by the height inserted
      // above it, so adding that height back leaves the viewport on the same
      // Message -- which is what "does not jump" means.
      //
      // KNOWN LIMITATION: the correction uses the virtualizer's total, which
      // still reads the estimate for rows that have not been measured yet, so
      // the viewport is left off by the estimate's error -- observed at ~64px
      // per page against the 10,000-Message seed. Correcting from measured
      // height instead is not simply a better number to use: every attempt so
      // far either re-entered the virtualizer's own `flushSync` measurement
      // (which React refuses outright) or moved the viewport further. Tracked
      // as follow-up work; the position is stable and off by a bounded amount,
      // rather than unstable.
      element.scrollTop += totalSize - previousTotalSize.current;
    } else if (pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }

    previousTotalSize.current = totalSize;
    previousCount.current = entries.length;
    firstKey.current = currentFirstKey;
  }, [entries, totalSize]);

  /**
   * Requests the next page on a fresh task rather than inline.
   *
   * The virtualizer measures rows with `flushSync`, and a microtask still runs
   * inside the task that flush belongs to -- so the resulting `setState` lands
   * mid-render and React refuses it. A timeout puts the request in a later
   * task, after layout has settled, which is both what React requires and
   * where a fetch belongs anyway.
   */
  const requestOlder = useCallback(() => {
    setTimeout(onLoadOlder, 0);
  }, [onLoadOlder]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    pinnedToBottom.current = isAtBottom();

    if (!reachedStart && element.scrollTop < LOAD_OLDER_THRESHOLD_PX) {
      requestOlder();
    }
  }, [isAtBottom, requestOlder, reachedStart]);

  // A Conversation short enough not to fill the viewport never fires a scroll event,
  // so the first page would be the last one the reader ever got.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || reachedStart || loadingOlder) return;
    if (element.scrollHeight <= element.clientHeight) requestOlder();
  }, [entries.length, loadingOlder, requestOlder, reachedStart]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="relative flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
      role="log"
      aria-live="polite"
      aria-label="Messages"
    >
      {/*
        Overlaid rather than placed in the scroll flow. A banner that occupies
        height while it is visible pushes every row down by exactly its own
        height, and pulls them back up when it goes -- which is a viewport jump
        of precisely the size of the loading indicator, on every page load.
        Taking it out of the flow is what keeps the anchoring exact.
      */}
      {loadingOlder ? (
        <p className="bg-background/85 text-muted pointer-events-none absolute inset-x-0 top-0 z-10 py-2 text-center text-[12px] leading-4">
          Loading earlier messages…
        </p>
      ) : null}
      {reachedStart && entries.length > 0 ? (
        <p className="text-muted pb-4 text-center text-[12px] leading-4">
          This is the beginning of the conversation.
        </p>
      ) : null}

      <div className="relative w-full" style={{ height: `${totalSize}px` }}>
        {items.map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          const mine = entry.senderId === viewerId;

          return (
            <div
              key={item.key}
              // Measured rather than estimated: heights vary by Message, and
              // the virtualizer needs the real one to place what follows.
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <div
                className={cn(
                  "flex w-full flex-col gap-1 pb-3",
                  mine ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-[12px] px-3 py-2 text-[14px] leading-5 break-words whitespace-pre-wrap sm:max-w-[70%]",
                    mine
                      ? "bg-foreground text-elevated"
                      : "bg-elevated text-foreground shadow-border",
                    // Pending is signalled by weight, not by a spinner: the
                    // Message is readable throughout, and settling is a
                    // one-property change rather than a layout shift.
                    entry.pending && "opacity-60",
                    entry.failed && "shadow-[0_0_0_1px_var(--color-status-red)]",
                  )}
                >
                  {entry.body}
                </div>
                <span className="px-1 text-[12px] leading-4 text-muted">
                  {entry.failed
                    ? "Not delivered"
                    : entry.pending
                      ? "Sending…"
                      : formatTime(entry.createdAt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
