import { describe, expect, it } from "vitest";
import { createPresenceRegistry } from "@/lib/presence";

describe("presence", () => {
  it("reports a User as offline before they connect", () => {
    const presence = createPresenceRegistry();

    expect(presence.isOnline("ada")).toBe(false);
  });

  it("reports a User as online while they hold a connection", () => {
    const presence = createPresenceRegistry();

    presence.connected("ada", "socket-1");

    expect(presence.isOnline("ada")).toBe(true);
  });

  it("reports a User as offline once their only connection goes", () => {
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");

    presence.disconnected("ada", "socket-1");

    expect(presence.isOnline("ada")).toBe(false);
  });

  it("keeps a User online when one of two tabs closes", () => {
    // Presence is whether a User holds *any* live connection (CONTEXT.md), so
    // closing one of two tabs must not sign them out of the other.
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");
    presence.connected("ada", "socket-2");

    presence.disconnected("ada", "socket-1");

    expect(presence.isOnline("ada")).toBe(true);
  });

  it("reports a User as offline only once every tab has closed", () => {
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");
    presence.connected("ada", "socket-2");

    presence.disconnected("ada", "socket-1");
    presence.disconnected("ada", "socket-2");

    expect(presence.isOnline("ada")).toBe(false);
  });

  it("tracks each User separately", () => {
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");
    presence.connected("grace", "socket-2");

    presence.disconnected("ada", "socket-1");

    expect(presence.isOnline("ada")).toBe(false);
    expect(presence.isOnline("grace")).toBe(true);
  });

  it("counts connections by identity, so one socket cannot register twice", () => {
    // Socket.IO can deliver a reconnection whose id this registry already
    // holds. Counting a bare number would leave the User permanently online:
    // two increments, one decrement, and nothing left to balance it.
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");
    presence.connected("ada", "socket-1");

    presence.disconnected("ada", "socket-1");

    expect(presence.isOnline("ada")).toBe(false);
  });

  it("brings a User back online when recovery reuses their socket id", () => {
    // Socket.IO's `connectionStateRecovery` reuses a socket id across a
    // recovered reconnection, so the same id arrives again after the
    // disconnect that removed it. A transition answered from whether the *id*
    // looked familiar would report "already online" and skip the broadcast,
    // leaving a single-tab User shown offline while they are connected.
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");

    expect(presence.disconnected("ada", "socket-1")).toBe(true);
    expect(presence.connected("ada", "socket-1")).toBe(true);
    expect(presence.isOnline("ada")).toBe(true);
  });

  it("ignores a disconnection it never saw connect", () => {
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");

    presence.disconnected("ada", "socket-unknown");

    expect(presence.isOnline("ada")).toBe(true);
  });

  it("reports whether the User changed state, so a broadcast happens only on a real transition", () => {
    // Opening a second tab is not a presence change, and telling the other
    // Participant that it is would have their indicator flicker on every tab
    // somebody opens.
    const presence = createPresenceRegistry();

    expect(presence.connected("ada", "socket-1")).toBe(true);
    expect(presence.connected("ada", "socket-2")).toBe(false);
    expect(presence.disconnected("ada", "socket-1")).toBe(false);
    expect(presence.disconnected("ada", "socket-2")).toBe(true);
  });

  it("forgets a User entirely once they go offline, so the registry does not grow without bound", () => {
    const presence = createPresenceRegistry();
    presence.connected("ada", "socket-1");

    presence.disconnected("ada", "socket-1");

    expect(presence.trackedUsers()).toEqual([]);
  });
});
