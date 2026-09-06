"use client";

import { useEffect, useState } from "react";
import type { ChatSocket } from "./use-socket";

/**
 * The open Conversation's live state: who is typing, and how far the other
 * Participant has read.
 *
 * Held apart from `useConversation` because neither is a Message. They have no
 * Sequence, they are not persisted, and they do not merge into history --
 * whereas a typing announcement arrives every couple of seconds while somebody
 * composes, and folding that into the Conversation state would invalidate the
 * value the virtualized message list measures against on a timer.
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
  otherLastReadSeq: string;
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
): LiveConversation {
  const [live, setLive] = useState<LiveConversation>(NOTHING_YET);

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

    const onTyping = (payload: { conversationId: string; userIds: string[] }) => {
      if (payload.conversationId !== conversationId) return;
      // The payload is the complete set of typists rather than a delta, so
      // this assignment repairs whatever a dropped broadcast may have missed.
      setLive((current) => ({
        ...current,
        otherTyping: payload.userIds.includes(otherUserId),
      }));
    };

    const onRead = (payload: {
      conversationId: string;
      userId: string;
      lastReadSeq: string;
    }) => {
      if (payload.conversationId !== conversationId) return;
      // The reader's own mark arrives here too -- the broadcast goes to the
      // whole room, which is how their other tabs clear the same badge. Only
      // the other side's mark is a read receipt.
      if (payload.userId !== otherUserId) return;
      setLive((current) => ({ ...current, otherLastReadSeq: payload.lastReadSeq }));
    };

    socket.on("conversation:typing", onTyping);
    socket.on("conversation:read", onRead);

    return () => {
      cancelled = true;
      socket.off("connect", seed);
      socket.off("conversation:typing", onTyping);
      socket.off("conversation:read", onRead);
    };
  }, [socket, conversationId, otherUserId]);

  return live;
}
