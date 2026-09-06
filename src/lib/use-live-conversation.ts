"use client";

import { useEffect, useRef, useState } from "react";
import type { Sequence } from "./sequence";
import type { ReadPayload, TypingPayload } from "./socket-events";
import { TYPING_TTL_MS } from "./typing";
import type { ChatSocket } from "./use-socket";

/**
 * The open Conversation's live state: who is typing, and how far the other
 * Participant has read.
 *
 * Held apart from `useConversation` because neither is a Message. They have no
 * Sequence of their own, they are not persisted, and they do not merge into
 * history -- whereas a typing announcement arrives every couple of seconds
 * while somebody composes, and folding that into the Conversation state would
 * invalidate the value the virtualized message list measures against on a
 * timer.
 *
 * Presence is deliberately not here. It is a property of a User rather than of
 * a Conversation, so it is tracked once for the whole list (see
 * `usePresentUsers`) rather than a second time per open Conversation, which
 * would let the header and the list row disagree about the same person.
 */
export interface LiveConversation {
  /** Whether the other Participant is composing right now. */
  otherTyping: boolean;
  /**
   * The other Participant's Read Mark. Everything at or below it has been read
   * by them (CONTEXT.md: Read Mark), which is what a receipt is drawn from.
   */
  otherLastReadSeq: Sequence;
}

const NOTHING_YET: LiveConversation = {
  otherTyping: false,
  otherLastReadSeq: "0",
};

/**
 * Tracks the open Conversation's typing and read state.
 *
 * Seeded from the join reply rather than by waiting for a broadcast. Both are
 * announced on transition, so a client that opens a Conversation between
 * transitions would otherwise show a stale answer -- a sender would see their
 * Message as unread even though the recipient read it an hour ago.
 */
export function useLiveConversation(
  socket: ChatSocket | null,
  conversationId: string | null,
  otherUserId: string | null,
  /**
   * Called when *this* reader's own Read Mark moves, in any tab.
   *
   * The unread count is derived on the server and rendered into the list
   * (CONTEXT.md: Unread Count -- derived, never stored), so the client cannot
   * recompute it; what it can do is say the derivation is now stale. Without
   * this the badge on the Conversation the reader just opened keeps its old
   * count until an unrelated Message happens to arrive, which is the one
   * moment the reader is most certain they have read everything.
   */
  onOwnReadMarkMoved?: () => void,
): LiveConversation {
  const [live, setLive] = useState<LiveConversation>(NOTHING_YET);

  // Held in a ref so a caller passing a fresh closure each render does not
  // tear down and re-establish every socket listener below.
  const onOwnReadRef = useRef(onOwnReadMarkMoved);
  onOwnReadRef.current = onOwnReadMarkMoved;

  useEffect(() => {
    // Reset on every change of Conversation, so the previous one's typing
    // indicator and read receipt do not carry into the newly opened one.
    setLive(NOTHING_YET);
    if (!socket || !conversationId || !otherUserId) return;

    /**
     * Asks for the snapshot the join reply carries.
     *
     * `useConversation` also joins, for its own reasons, and the room is
     * idempotent -- so this asks in its own right rather than depending on the
     * other hook running first. Two hooks that had to run in a set order would
     * be a coupling neither of them expresses.
     */
    let cancelled = false;
    const seed = () => {
      socket.emit("conversation:join", { conversationId }, (reply) => {
        if (cancelled || !reply.ok) return;
        setLive({
          otherTyping: reply.typing.includes(otherUserId),
          otherLastReadSeq: reply.otherLastReadSeq,
        });
      });
    };

    seed();
    // A reconnection starts a fresh session on the server, so the snapshot has
    // to be asked for again rather than assumed to have survived.
    socket.on("connect", seed);

    /**
     * Clears the indicator if no broadcast renews it within the lease.
     *
     * The server expires a typing lease lazily -- it is evaluated when
     * somebody reads the set, not by a timer (see `src/lib/typing.ts`). That
     * is the right model on the server, where every read is a fresh
     * evaluation, but it means there is no guarantee of a *further* broadcast
     * after the one that said somebody is typing. A typist whose browser is
     * killed outright sends no disconnect, and if nothing else touches that
     * Conversation, the last thing this client heard is "they are typing" and
     * it would stand forever.
     *
     * So the client holds the same lease the server does. An indicator that is
     * not renewed within the TTL puts itself away, which makes a stranded
     * indicator unrepresentable on this side too rather than merely unlikely.
     */
    let lapse: ReturnType<typeof setTimeout> | undefined;
    const clearLapse = () => {
      if (lapse !== undefined) clearTimeout(lapse);
      lapse = undefined;
    };

    const onTyping = (payload: TypingPayload) => {
      if (payload.conversationId !== conversationId) return;
      // The payload is the complete set of typists rather than a delta, so
      // this assignment repairs whatever a dropped broadcast may have missed.
      const typing = payload.userIds.includes(otherUserId);
      setLive((current) =>
        current.otherTyping === typing ? current : { ...current, otherTyping: typing },
      );

      clearLapse();
      if (typing) {
        lapse = setTimeout(() => {
          setLive((current) => ({ ...current, otherTyping: false }));
        }, TYPING_TTL_MS);
      }
    };

    const onRead = (payload: ReadPayload) => {
      if (payload.conversationId !== conversationId) return;
      if (payload.userId === otherUserId) {
        // The other side's mark is the read receipt the sender is waiting for.
        setLive((current) => ({ ...current, otherLastReadSeq: payload.lastReadSeq }));
        return;
      }
      // The reader's own mark, echoed back because the broadcast goes to the
      // whole room. It is not a receipt -- it is the signal that this reader's
      // unread count is now wrong, here and in whatever other tabs they have
      // open showing the same badge.
      onOwnReadRef.current?.();
    };

    socket.on("conversation:typing", onTyping);
    socket.on("conversation:read", onRead);

    return () => {
      cancelled = true;
      clearLapse();
      socket.off("connect", seed);
      socket.off("conversation:typing", onTyping);
      socket.off("conversation:read", onRead);
    };
  }, [socket, conversationId, otherUserId]);

  return live;
}
