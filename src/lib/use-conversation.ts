"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSocket } from "./use-socket";
import {
  applyAccepted,
  applyOlderPage,
  applyPending,
  emptyConversation,
  type ConversationState,
} from "./conversation-state";
import type { WireMessage, WireMessagePage } from "./wire";

/** How many Messages a page of history holds. */
const PAGE_SIZE = 50;

export interface OpenConversation {
  state: ConversationState;
  /** True while the first page is loading, so the Conversation can show a skeleton. */
  loading: boolean;
  /** True while an older page is in flight, so the top can show a spinner. */
  loadingOlder: boolean;
  error: string | null;
  send: (body: string) => void;
  loadOlder: () => void;
}

/**
 * Binds one Conversation to the socket and the history endpoint.
 *
 * The two sources are deliberately different shapes: live Messages are pushed
 * over the socket, and history is pulled page by page over HTTP as the reader
 * scrolls. Both fold into the same value through the functions in
 * conversation-state.ts, so ordering and deduplication are decided in one place
 * regardless of which direction a Message came from.
 */
export function useConversation(
  socket: ChatSocket | null,
  conversationId: string | null,
  viewerId: string,
): OpenConversation {
  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read inside callbacks that must not re-subscribe when the cursor moves.
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = state.nextCursor;
  const reachedStartRef = useRef(false);
  reachedStartRef.current = state.reachedStart;
  const inFlightRef = useRef(false);

  // The first page of a Conversation. Fetched fresh on every open rather than
  // cached, so a reader never opens a Conversation onto history that has since moved.
  useEffect(() => {
    if (!conversationId) {
      setState(emptyConversation());
      return;
    }

    let cancelled = false;
    inFlightRef.current = false;
    setState(emptyConversation());
    setLoading(true);
    setError(null);

    fetch(`/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as WireMessagePage;
      })
      .then((page) => {
        // A slow first page for a Conversation the reader has since navigated
        // away from must not overwrite the one they are now looking at.
        if (cancelled) return;
        setState((current) => applyOlderPage(current, page.messages, page.nextCursor));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        console.error("[conversation] loading history failed", cause);
        setError("Could not load this conversation.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // Joining the room is what makes this socket eligible for the broadcast; the
  // server runs the membership guard before admitting it.
  useEffect(() => {
    if (!socket || !conversationId) return;

    const join = () => {
      socket.emit("conversation:join", { conversationId }, (reply) => {
        if (!reply.ok) setError("You are not a participant of this conversation.");
      });
    };

    join();
    // A reconnect starts a fresh session on the server, so the room membership
    // has to be re-established rather than assumed to have survived.
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
    };
  }, [socket, conversationId]);

  useEffect(() => {
    if (!socket || !conversationId) return;

    const onMessage = (message: WireMessage) => {
      // One socket serves every Conversation, so a Message for a Conversation the
      // reader is not looking at is dropped here rather than mixed into it.
      if (message.conversationId !== conversationId) return;
      setState((current) => applyAccepted(current, message));
    };

    socket.on("message:new", onMessage);
    return () => {
      socket.off("message:new", onMessage);
    };
  }, [socket, conversationId]);

  const send = useCallback(
    (body: string) => {
      if (!socket || !conversationId) return;

      // Generated before the Message leaves the browser: it is the idempotency
      // key the server's constraint arbitrates on, and the key the pending
      // entry is settled by when the ack returns.
      const clientMessageId = crypto.randomUUID();

      setState((current) =>
        applyPending(current, {
          clientMessageId,
          senderId: viewerId,
          body,
          createdAt: new Date().toISOString(),
        }),
      );

      socket.emit("message:send", { conversationId, clientMessageId, body }, (reply) => {
        if (reply.ok) {
          setState((current) => applyAccepted(current, reply.message));
          return;
        }
        // The Message stays visible and is marked failed rather than vanishing:
        // a sender must be able to see what was not delivered.
        setState((current) => ({
          ...current,
          entries: current.entries.map((entry) =>
            entry.clientMessageId === clientMessageId
              ? { ...entry, pending: false, failed: true }
              : entry,
          ),
        }));
      });
    },
    [socket, conversationId, viewerId],
  );

  const loadOlder = useCallback(() => {
    const cursor = cursorRef.current;
    if (!conversationId || cursor === null || reachedStartRef.current) return;
    // One page at a time. Scroll events fire in bursts, and a second request
    // for the same cursor would fetch a page the Conversation already holds. The
    // guard is a ref rather than the loading state because it has to be read
    // and set synchronously within one burst, before React re-renders.
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setLoadingOlder(true);

    fetch(
      `/api/conversations/${conversationId}/messages?limit=${PAGE_SIZE}&before=${cursor}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as WireMessagePage;
      })
      .then((page) => {
        setState((current) => applyOlderPage(current, page.messages, page.nextCursor));
      })
      .catch((cause: unknown) => {
        console.error("[conversation] loading older messages failed", cause);
      })
      .finally(() => {
        inFlightRef.current = false;
        setLoadingOlder(false);
      });
  }, [conversationId]);

  return { state, loading, loadingOlder, error, send, loadOlder };
}
