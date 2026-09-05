"use client";

import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "./socket-events";

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * Holds a single socket to the same origin for the component's lifetime and
 * reports its connection status, which the UI surfaces so the user can tell
 * whether the state they are looking at is live.
 */
export function useSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [socket, setSocket] = useState<ChatSocket | null>(null);

  useEffect(() => {
    const s: ChatSocket = io({ withCredentials: true });
    setSocket(s);

    s.on("connect", () => setStatus("connected"));
    s.on("disconnect", () => setStatus("disconnected"));
    s.io.on("reconnect_attempt", () => setStatus("connecting"));

    return () => {
      s.close();
    };
  }, []);

  return { socket, status };
}
