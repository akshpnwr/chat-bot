"use client";

import { useEffect, useMemo, useState } from "react";
import type { PresencePayload } from "./socket-events";
import type { ChatSocket } from "./use-socket";

/**
 * Who, among the people the viewer has Conversations with, is online.
 *
 * Separate from `useLiveConversation` because the question is different in
 * scope: that hook answers "is the person I am looking at online", scoped to
 * the open Conversation, while this answers it for every row of the list at
 * once. A User's Presence is a property of the User rather than of any
 * Conversation, so one set serves every row.
 *
 * Seeded from a snapshot and then kept current by transitions. Without the
 * snapshot the list would show everybody offline until they each happened to
 * reconnect, which for somebody already online is never.
 */
export function usePresentUsers(
  socket: ChatSocket | null,
  /** The other Participants across the viewer's Conversations. */
  userIds: readonly string[],
): ReadonlySet<string> {
  const [online, setOnline] = useState<ReadonlySet<string>>(() => new Set());

  // Joined into a stable key so the effect below does not re-subscribe on every
  // render merely because the caller built a new array of the same ids. The
  // key is compared, never parsed back apart -- round-tripping ids through a
  // delimiter would put a constraint on what an id may contain, and nothing
  // says an id may not contain a comma.
  const key = userIds.join(",");
  const watched = useMemo(() => [...userIds], [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!socket) return;

    let cancelled = false;

    const seed = () => {
      socket.emit("presence:snapshot", { userIds: watched }, (reply) => {
        if (cancelled || !reply.ok) return;
        setOnline(new Set(reply.online));
      });
    };

    seed();
    // A reconnection means the snapshot this client holds describes a session
    // the server has since forgotten, so it is asked for again.
    socket.on("connect", seed);

    const onPresence = (payload: PresencePayload) => {
      if (!watched.includes(payload.userId)) return;
      setOnline((current) => {
        // A transition for somebody already in the state it announces changes
        // nothing, and returning the same Set avoids re-rendering the list.
        if (current.has(payload.userId) === payload.online) return current;
        const next = new Set(current);
        if (payload.online) next.add(payload.userId);
        else next.delete(payload.userId);
        return next;
      });
    };

    socket.on("presence:changed", onPresence);

    return () => {
      cancelled = true;
      socket.off("connect", seed);
      socket.off("presence:changed", onPresence);
    };
  }, [socket, watched]);

  return online;
}
