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
}

export interface SocketData {
  userId: string;
}
