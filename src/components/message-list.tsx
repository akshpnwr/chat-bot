"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isRead, type ConversationEntry } from "@/lib/conversation-state";
import type { Sequence } from "@/lib/sequence";
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
 *    Rows are inserted above the viewport, so the reader is held on one real
 *    Message across the insert and the measurements that follow it -- the
 *    anchoring the ticket asks for. See the layout effect below for why this is
 *    done by a Message's offset rather than by height arithmetic.
 */
export function MessageList({
  entries,
  viewerId,
  onLoadOlder,
  loadingOlder,
  reachedStart,
  otherLastReadSeq,
}: {
  entries: ConversationEntry[];
  viewerId: string;
  onLoadOlder: () => void;
  loadingOlder: boolean;
  reachedStart: boolean;
  /**
   * The other Participant's Read Mark. One number answers "has this been read"
   * for every Message in the Conversation, because the mark is a high-water
   * mark rather than a per-Message flag (CONTEXT.md: Read Mark) -- so a
   * ten-thousand-Message thread costs one value rather than ten thousand.
   */
  otherLastReadSeq: Sequence;
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
  /**
   * True from a prepend until the rows it added have all been measured, during
   * which every growth of the total is that page settling into its real height.
   */
  const settling = useRef(false);
  /**
   * The Message the reader's position is held against while a page settles, and
   * how far below the top of the viewport it sat when the page was requested.
   */
  const anchorKey = useRef<string | null>(null);
  const anchorOffset = useRef(0);
  const previousCount = useRef(0);
  const pinnedToBottom = useRef(true);

  const firstKey = useRef<string | null>(null);

  /**
   * Puts the anchored Message back at the offset it held. The row's measured
   * `start` is read from the virtualizer rather than from the DOM: rows are
   * absolutely positioned, so their laid-out offset is the estimate until the
   * measurement lands, whereas the cache carries the real figure as soon as it
   * is known.
   */
  const restoreAnchor = useCallback(
    (element: HTMLDivElement) => {
      const index = entries.findIndex(
        (entry) => entry.clientMessageId === anchorKey.current,
      );
      if (index === -1) return;
      const start = virtualizer.measurementsCache[index]?.start;
      if (start === undefined) return;
      element.scrollTop = start - anchorOffset.current;
    },
    [entries, virtualizer],
  );

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
      // Anchor on a Message rather than on a height.
      //
      // Height arithmetic cannot close this gap. The virtualizer lays prepended
      // rows out at an estimate and revises the total as each is measured, so
      // every height available during that window is provisional -- and the DOM
      // offers no better one, because the rows are absolutely positioned and
      // the container's `scrollHeight` is merely the spacer, which is the
      // estimate again. Correcting by a provisional number leaves the viewport
      // off by however wrong the estimate was.
      //
      // A row's own offset, by contrast, is a fact at every instant. Holding
      // one real Message at the offset it already occupied is also the literal
      // statement of what the reader wants: the thing they were reading does
      // not move.
      restoreAnchor(element);
      // Held until the measurements stop changing, because each remeasure moves
      // that Message again and it has to be put back each time.
      settling.current = true;
    } else if (settling.current) {
      restoreAnchor(element);
      if (totalSize === previousTotalSize.current) settling.current = false;
    } else if (pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }

    previousTotalSize.current = totalSize;
    previousCount.current = entries.length;
    firstKey.current = currentFirstKey;
  }, [entries, restoreAnchor, totalSize]);

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
    // Note which Message the reader is on *before* asking for more, while the
    // list on screen is still the one they are looking at. This is the row the
    // prepend will be anchored to.
    const element = scrollRef.current;
    if (element) {
      const offset = element.scrollTop;
      const first = virtualizer
        .getVirtualItems()
        .find((item) => item.start >= offset);
      if (first) {
        anchorKey.current = String(first.key);
        anchorOffset.current = first.start - offset;
      }
    }
    setTimeout(onLoadOlder, 0);
  }, [onLoadOlder, virtualizer]);

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
                  // A stable hook for the browser tests, which have to count
                  // how many times a Message is on screen rather than merely
                  // find it -- a duplicate delivered by reconnection would
                  // satisfy "is visible" and is exactly what they rule out.
                  data-message-body
                  data-pending={entry.pending ? "true" : undefined}
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
                <span
                  className={cn(
                    "px-1 text-[12px] leading-4",
                    // A refusal is read as an instruction rather than as
                    // metadata, so it is coloured like one; an ordinary
                    // timestamp stays quiet.
                    entry.failureReason ? "text-status-red" : "text-muted",
                  )}
                >
                  {/*
                    The reason, where the server gave one -- which term was
                    refused, so the sender can edit rather than guess. It
                    replaces "Not delivered" rather than joining it: naming the
                    term already says the Message did not go.
                  */}
                  {entry.failureReason
                    ? entry.failureReason
                    : entry.failed
                    ? "Not delivered"
                    : entry.pending
                      ? "Sending…"
                      : formatTime(entry.createdAt)}
                  {/*
                    Only on the viewer's own Messages, and only once accepted.
                    A receipt on a received Message would be telling the reader
                    what they themselves have read, which is not information;
                    the sender is the one who wanted to know it landed.
                  */}
                  {mine && !entry.pending && !entry.failed
                    ? isRead(entry, otherLastReadSeq)
                      ? " · Read"
                      : " · Sent"
                    : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
