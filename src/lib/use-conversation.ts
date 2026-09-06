"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSocket } from "./use-socket";
import {
  applyAccepted,
  applyOlderPage,
  applyPending,
  applyRetrying,
  applySyncGap,
  emptyConversation,
  highestSequence,
  type ConversationState,
} from "./conversation-state";
import {
  browserOutboxStore,
  loadOutbox,
  recordSend,
  settleSend,
  type OutboxEntry,
  type OutboxStore,
} from "./outbox";
import {
  createTypingAnnouncer,
  TYPING_IDLE_MS,
  type TypingAnnouncer,
} from "./typing-announcer";
import { isAfter, maxSequence, type Sequence } from "./sequence";
import type { SyncReply } from "./socket-events";
import type { WireMessage, WireMessagePage } from "./wire";

/** How many Messages a page of history holds. */
const PAGE_SIZE = 50;

/**
 * How often the announcer is asked whether the reader has gone idle.
 *
 * A fraction of the idle threshold, so a pause is noticed close to when it
 * actually crosses it rather than up to a full threshold late. This is a
 * polling interval rather than a timer set per keystroke -- one interval for
 * the open Conversation, instead of a timer created and cleared on every
 * letter typed.
 */
const TYPING_TICK_MS = Math.floor(TYPING_IDLE_MS / 3);

/**
 * How many sync rounds one recovery drains before stopping.
 *
 * This is a real ceiling, not merely a liveness guard: at 200 Messages a round
 * it caps one recovery at 10,000, and a gap wider than that is left partly
 * unrecovered. That is a deliberate trade -- an unbounded loop against a
 * pathological gap would hold the Conversation in "Catching up" indefinitely --
 * but it is a limit, so hitting it is logged rather than passed over in silence.
 * The reader's next reconnection resumes from the cursor they now hold, so the
 * remainder is recovered then rather than lost.
 */
const MAX_SYNC_ROUNDS = 50;

export interface OpenConversation {
  state: ConversationState;
  /** True while the first page is loading, so the Conversation can show a skeleton. */
  loading: boolean;
  /** True while an older page is in flight, so the top can show a spinner. */
  loadingOlder: boolean;
  /**
   * True while missed Messages are being recovered after a reconnection, so
   * the user is told catching up is happening rather than watching the
   * Conversation quietly fill in.
   */
  syncing: boolean;
  error: string | null;
  send: (body: string) => void;
  loadOlder: () => void;
  /**
   * Announces that the reader is composing, or has stopped. Throttled inside
   * (see `typing-announcer.ts`) rather than by the caller, so a component
   * calling this on every keystroke is doing the right thing.
   */
  setTyping: (typing: boolean) => void;
}

/** One sync round trip, as a promise, so the drain below reads as a loop. */
function requestSync(
  socket: ChatSocket,
  conversationId: string,
  since: Sequence | null,
): Promise<SyncReply> {
  return new Promise((resolve) => {
    socket.emit("conversation:sync", { conversationId, since }, resolve);
  });
}

/**
 * Binds one Conversation to the socket and the history endpoint.
 *
 * The two sources are deliberately different shapes: live Messages are pushed
 * over the socket, and history is pulled page by page over HTTP as the reader
 * scrolls. Both fold into the same value through the functions in
 * conversation-state.ts, so ordering and deduplication are decided in one place
 * regardless of which direction a Message came from.
 *
 * Reconnection adds a third source with the same shape. Two mechanisms compose
 * there: the transport replays a short buffer for a momentary blip, and the
 * sync below asks the database for whatever that buffer cannot cover. Because
 * all three routes fold through the same merge, a Message that arrives twice --
 * live and again in a gap -- is still rendered once.
 */
export function useConversation(
  socket: ChatSocket | null,
  conversationId: string | null,
  viewerId: string,
): OpenConversation {
  const [state, setState] = useState<ConversationState>(emptyConversation);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read inside callbacks that must not re-subscribe when the cursor moves.
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = state.nextCursor;
  const reachedStartRef = useRef(false);
  reachedStartRef.current = state.reachedStart;
  const inFlightRef = useRef(false);

  // The Sync Cursor is read from here rather than from a closure over `state`:
  // recovery runs inside a socket listener registered once per Conversation,
  // and a closure would report what the Conversation held when that listener
  // was created rather than what it holds now -- which is exactly the stale
  // cursor that would re-request Messages already held, or skip newer ones.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Resolved on the client only. `localStorage` does not exist during the
  // server render, so reading it at module scope would break hydration.
  const outboxRef = useRef<OutboxStore | null>(null);
  useEffect(() => {
    outboxRef.current = browserOutboxStore();
  }, []);

  /**
   * The typing announcer for the open Conversation, built by the effect near
   * the bottom of this hook. Declared up here because `send` reaches for it to
   * stop announcing the moment a Message goes out, and `send` is defined
   * first.
   */
  const announcerRef = useRef<TypingAnnouncer | null>(null);

  /**
   * The Read Mark this browser has already announced.
   *
   * Held so the effect below only emits when the mark actually advances. The
   * effect runs on every state change -- every Message, every settle -- and
   * without this it would announce the same Sequence repeatedly, putting a
   * write and a broadcast on the wire for each one.
   */
  const announcedReadRef = useRef<Sequence | null>(null);
  useEffect(() => {
    announcedReadRef.current = null;
  }, [conversationId]);

  /**
   * Advances the reader's Read Mark to the newest Message they hold.
   *
   * Opening a Conversation is what marks it read, and so is receiving a
   * Message while it is open -- both reduce to "the highest Sequence on
   * screen", so both are this one effect rather than two call sites that could
   * drift apart.
   *
   * It deliberately does not check whether the tab is focused. The ticket asks
   * that opening a Conversation clears its unread count, and treating a
   * background tab as unread would mean a badge that reappears when the reader
   * switches windows without anything having arrived.
   *
   * Monotonicity is not enforced here. The server refuses a backwards advance
   * (see `advanceReadMark`), which is the only place it can be enforced
   * correctly with two tabs open -- so this is free to announce whatever it
   * holds and let the server arbitrate.
   */
  useEffect(() => {
    if (!socket || !conversationId) return;

    const highest = highestSequence(state);
    if (highest === null) return;
    if (
      announcedReadRef.current !== null &&
      !isAfter(highest, announcedReadRef.current)
    ) {
      return;
    }

    announcedReadRef.current = highest;
    socket.emit("conversation:read", { conversationId, upTo: highest }, (reply) => {
      if (reply.ok) return;
      // Left un-announced rather than retried here: the next Message to arrive
      // advances the mark again, and a reconnection re-runs this effect with
      // whatever the Conversation holds by then.
      announcedReadRef.current = null;
      console.error("[conversation] advancing the Read Mark failed", reply.error);
    });
  }, [socket, conversationId, state]);

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

  /**
   * Sends a Message over the socket and settles it when the server answers.
   *
   * The Message is recorded in the outbox before it goes over the wire and
   * dropped from it on acceptance. That ordering is the guarantee: a Message
   * which reaches storage before it reaches the socket is one a reload in
   * between cannot lose.
   *
   * A send that fails is left in the outbox deliberately. The next reconnection
   * retries it under the same Client Message Id, which is why an outage that
   * outlasts the socket does not cost the sender their Message.
   */
  const emitSend = useCallback((activeSocket: ChatSocket, entry: OutboxEntry) => {
    activeSocket.emit(
      "message:send",
      {
        conversationId: entry.conversationId,
        clientMessageId: entry.clientMessageId,
        body: entry.body,
      },
      (reply) => {
        const store = outboxRef.current;

        if (reply.ok) {
          if (store) settleSend(store, entry.conversationId, entry.clientMessageId);
          setState((current) => applyAccepted(current, reply.message));
          return;
        }

        // Neither refusal becomes acceptance by being retried: membership does
        // not change by asking again, and the same words screened again are
        // refused for the same term. So both leave the outbox, rather than
        // going back on the wire at every reconnection for the rest of the
        // session. Only a transport or server failure is worth retrying.
        const permanent =
          reply.error === "NOT_A_PARTICIPANT" || reply.error === "PROHIBITED_LANGUAGE";
        if (permanent && store) {
          settleSend(store, entry.conversationId, entry.clientMessageId);
        }

        // The Message stays visible and is marked failed rather than vanishing:
        // a sender must be able to see what was not delivered. Where the server
        // named a reason it is carried onto the entry, so the notice sits on the
        // Message it is about rather than beside the Conversation as a whole.
        const failureReason =
          reply.error === "PROHIBITED_LANGUAGE" && reply.term !== undefined
            ? `Not sent: "${reply.term}" is not allowed`
            : undefined;

        setState((current) => ({
          ...current,
          entries: current.entries.map((held) =>
            held.clientMessageId === entry.clientMessageId
              ? { ...held, pending: false, failed: true, failureReason }
              : held,
          ),
        }));
      },
    );
  }, []);

  /**
   * Rejoins, recovers what was missed, then retries what was never acknowledged.
   *
   * Runs on every connect, the first included -- a fresh page load and a
   * reconnection differ only in how much the client already holds, and the
   * cursor already expresses that difference. Making them one path means
   * recovery is exercised on every load rather than only in the rare case, so
   * it cannot quietly rot into something that fails when it is finally needed.
   *
   * The order within it matters. Syncing before retrying means a Message this
   * browser sent but never saw acked -- one the server may well have Accepted,
   * with only the ack lost -- comes back in the gap and settles its outbox
   * entry, leaving the retry nothing to send. Retrying first would put a
   * duplicate on the wire for every such Message. The idempotency constraint
   * collapses those to one Message either way, so this is the difference
   * between that constraint being a backstop and it being the routine path.
   */
  useEffect(() => {
    if (!socket || !conversationId) return;

    let cancelled = false;

    const recover = async () => {
      // The guard runs before the join, so a non-member never enters the room.
      const joined = await new Promise<boolean>((resolve) => {
        socket.emit("conversation:join", { conversationId }, (reply) => {
          resolve(reply.ok);
        });
      });
      if (cancelled) return;
      if (!joined) {
        setError("You are not a participant of this conversation.");
        return;
      }

      // Deliberately not set before the first round.
      //
      // Every connection syncs, including a first page load with nothing to
      // recover, and announcing "Catching up" for the round trip that comes
      // back empty would make the indicator mean "a request is in flight"
      // rather than "Messages you missed are arriving". It is raised below,
      // once a round actually returns something -- so when the user sees it,
      // recovery is genuinely what is happening.
      try {
        // The cursor is carried through the loop rather than re-read from state
        // between rounds.
        //
        // `setState` is asynchronous and `stateRef` is only refreshed when React
        // re-renders, so a round that read the cursor back out of state could
        // see the value from before the previous round's Messages were folded
        // in -- and would then ask for the page it just received. The merge
        // makes that harmless to what the reader sees, but the drain would stop
        // advancing while `hasMore` stayed true, which is a gap that never
        // finishes recovering. Advancing from the reply itself is what makes
        // each round strictly follow the last.
        //
        // It starts from what is held, which is the Sync Cursor proper: the
        // highest Sequence this client actually has (CONTEXT.md: Sync Cursor).
        let since = highestSequence(stateRef.current);
        let drained = false;

        for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
          const reply = await requestSync(socket, conversationId, since);
          if (cancelled) return;

          if (!reply.ok) {
            console.error("[conversation] sync failed", reply.error);
            return;
          }

          if (reply.messages.length > 0) {
            // Raised here rather than before the loop: this is the first moment
            // it is true that Messages the reader missed are arriving, which is
            // what the indicator claims. A sync that comes back empty never
            // raises it, so opening a Conversation with nothing to recover does
            // not flash "Catching up" at somebody who missed nothing.
            setSyncing(true);
            setState((current) => applySyncGap(current, reply.messages));
            // A recovered Message may be one this browser sent and never saw
            // acked, so acceptance settles the outbox here just as an ack does.
            const store = outboxRef.current;
            if (store) {
              for (const message of reply.messages) {
                settleSend(store, conversationId, message.clientMessageId);
              }
            }
            // The reply is ordered by Sequence ascending, so its last Message is
            // the highest this client now holds.
            const highest = maxSequence(reply.messages.map((message) => message.seq));
            if (highest !== null) since = highest;
          }

          if (!reply.hasMore) {
            drained = true;
            break;
          }

          // A page that says there is more but carried nothing cannot be
          // advanced past, so continuing would re-request it until the round
          // limit ran out. Stopping is the honest response.
          if (reply.messages.length === 0) {
            console.error("[conversation] sync reported more but sent nothing");
            break;
          }
        }

        // Stopped with Messages still outstanding. Said out loud rather than
        // passed over, because the Conversation on screen is now knowingly
        // incomplete -- the next reconnection resumes from the cursor the
        // reader holds and recovers the rest.
        if (!drained) {
          console.warn(
            `[conversation] sync stopped after ${MAX_SYNC_ROUNDS} rounds with more to recover`,
          );
        }
      } finally {
        if (!cancelled) setSyncing(false);
      }

      // Whatever the sync did not account for was never Accepted, and goes back
      // on the wire under its original Client Message Id.
      const store = outboxRef.current;
      if (!store || cancelled) return;
      for (const pending of loadOutbox(store, conversationId)) {
        if (cancelled) return;
        // Rendered as pending again: a Message retried after a reload has no
        // entry in this page's state yet, and the sender should see it waiting
        // rather than see it reappear only once it is accepted.
        setState((current) =>
          applyRetrying(
            applyPending(current, {
              clientMessageId: pending.clientMessageId,
              senderId: viewerId,
              body: pending.body,
              createdAt: pending.createdAt,
            }),
            // A Message this page already holds is left untouched by
            // `applyPending`, so an earlier failure would still be showing "Not
            // delivered" while the retry below puts it back on the wire.
            pending.clientMessageId,
          ),
        );
        emitSend(socket, pending);
      }
    };

    /**
     * One recovery at a time.
     *
     * Mounting against an already-connected socket and the `connect` event can
     * both fire for the same connection, and two drains running together read
     * the same cursor and replay the same outbox. Idempotency means the reader
     * still sees each Message once, but it makes the server's constraint the
     * routine path rather than the backstop the design intends -- and doubles
     * the traffic of every reconnection. The guard is a plain flag because the
     * check and the set have to happen in one synchronous step.
     */
    let running = false;
    const runRecovery = () => {
      if (running) return;
      running = true;
      void recover().finally(() => {
        running = false;
      });
    };

    runRecovery();
    // A reconnect starts a fresh session on the server, so membership and the
    // gap have to be re-established rather than assumed to have survived.
    socket.on("connect", runRecovery);

    return () => {
      cancelled = true;
      socket.off("connect", runRecovery);
    };
  }, [socket, conversationId, viewerId, emitSend]);

  useEffect(() => {
    if (!socket || !conversationId) return;

    const onMessage = (message: WireMessage) => {
      // One socket serves every Conversation, so a Message for a Conversation the
      // reader is not looking at is dropped here rather than mixed into it.
      if (message.conversationId !== conversationId) return;
      // The broadcast reaches the sender's own other tabs, where the Message
      // may still sit in the outbox with no ack of its own to settle it.
      const store = outboxRef.current;
      if (store) settleSend(store, conversationId, message.clientMessageId);
      setState((current) => applyAccepted(current, message));
    };

    socket.on("message:new", onMessage);
    return () => {
      socket.off("message:new", onMessage);
    };
  }, [socket, conversationId]);

  /**
   * Writes a Message, whether or not there is a connection to send it over.
   *
   * Sending offline is a supported case rather than an edge one. The Message is
   * recorded, rendered as pending, and put on the wire only if there is a wire;
   * if there is not, the next reconnection finds it in the outbox and sends it
   * then. That is what lets the composer stay writable during an outage --
   * locking it would protect nothing and would discard whatever the user was
   * part-way through typing.
   */
  const send = useCallback(
    (body: string) => {
      if (!conversationId) return;

      // Generated before the Message leaves the browser: it is the idempotency
      // key the server's constraint arbitrates on, the key the pending entry is
      // settled by when the ack returns, and the key a retry after a reload
      // reuses so that retry is the same send rather than a second one.
      const clientMessageId = crypto.randomUUID();
      const entry: OutboxEntry = {
        clientMessageId,
        conversationId,
        body,
        createdAt: new Date().toISOString(),
      };

      // Durable before it is optimistic. A Message rendered but not recorded is
      // one a reload erases with no trace left that it was ever written.
      const store = outboxRef.current;
      if (store) recordSend(store, entry);

      setState((current) =>
        applyPending(current, {
          clientMessageId,
          senderId: viewerId,
          body,
          createdAt: entry.createdAt,
        }),
      );

      // Only attempted when there is something to attempt it on. A send emitted
      // into a disconnected socket is buffered by the transport with no ack
      // ever returning, which would leave the Message pending forever with
      // nothing to settle it; leaving it to the reconnection means one retry
      // path rather than two, and it is the path already under test.
      if (socket?.connected) emitSend(socket, entry);

      // Sending ends composing, and says so at once rather than letting the
      // idle timer notice a few seconds later -- by which point the Message
      // itself has already arrived, and an indicator still claiming the sender
      // is typing contradicts what the recipient can see.
      announcerRef.current?.stop();
    },
    [socket, conversationId, viewerId, emitSend],
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

  /**
   * Announces typing, throttled, and stops on its own once the reader pauses.
   *
   * The announcer holds the throttle and the idle rule (see
   * `typing-announcer.ts`); this effect owns only the two things that need
   * React -- the interval that lets an idle pause be noticed, and the cleanup
   * that stops announcing when the Conversation closes.
   *
   * The interval is what turns "stopped typing" from an event the user has to
   * generate into the mere absence of one. Nothing the reader does says "I
   * have stopped"; they simply stop, and the tick notices.
   */
  useEffect(() => {
    if (!socket || !conversationId) {
      announcerRef.current = null;
      return;
    }

    const announcer = createTypingAnnouncer({
      announce: (typing) => {
        socket.emit("conversation:typing", { conversationId, typing });
      },
    });
    announcerRef.current = announcer;

    const interval = setInterval(() => announcer.tick(), TYPING_TICK_MS);

    return () => {
      clearInterval(interval);
      announcerRef.current = null;
      // Closing the Conversation ends composing in it. The server's lease
      // would lapse on its own a few seconds later -- that is the guarantee --
      // but saying so immediately means the other side's indicator clears when
      // the reader actually stopped rather than seconds afterwards.
      announcer.stop();
    };
  }, [socket, conversationId]);

  const setTyping = useCallback((typing: boolean) => {
    if (typing) announcerRef.current?.keystroke();
    else announcerRef.current?.stop();
  }, []);

  return { state, loading, loadingOlder, syncing, error, send, loadOlder, setTyping };
}
