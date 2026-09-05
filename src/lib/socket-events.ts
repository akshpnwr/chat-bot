/**
 * The socket wire contract, shared by client and server.
 *
 * Note what is absent: no event payload carries a user id. Identity is pinned
 * to the connection at handshake time (see server/socket.ts), so a client
 * cannot claim to be somebody else by shaping a payload.
 */

export interface ServerToClientEvents {
  "connection:ready": (payload: { userId: string }) => void;
}

export interface ClientToServerEvents {
  ping: (callback: (reply: { ok: true; at: number }) => void) => void;
  /**
   * Join a Conversation's broadcast room. The server runs the membership guard
   * before joining, so a non-member never enters the room at all.
   */
  "conversation:join": (
    payload: { conversationId: string },
    callback: (reply: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
}

export interface SocketData {
  /**
   * Established from the session cookie at handshake time and fixed for the
   * connection's lifetime. Never read from an event payload.
   */
  userId: string;
}
