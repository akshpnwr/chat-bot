/**
 * Who currently holds a live connection.
 *
 * Presence is derived from live connections rather than stored as a field
 * (CONTEXT.md: Presence), which makes it correct by construction in the one
 * case that usually gets it wrong: a User with three tabs open is online, and
 * closing one of them is not a sign-out. A boolean column would need every
 * disconnect to decide whether it was the last one, and every crashed process
 * would leave somebody online forever.
 *
 * Holding it in process memory is what ADR-0001 buys -- a single long-lived
 * Node process means live connections and the truth about them are in the same
 * place. On more than one instance this would need the Socket.IO Redis
 * adapter; that is noted in the ADR and deliberately not built.
 *
 * Connections are tracked by identity rather than counted, because a count is
 * a thing that can drift. A reconnection that re-registers an id already held
 * would increment a counter that only ever gets decremented once, leaving the
 * User online for the rest of the process's life with nothing able to correct
 * it. A set of ids cannot drift that way: registering the same id twice is the
 * same one connection.
 *
 * Note what a transition is answered from: whether the *User* held any
 * connection, never whether the *id* was novel. The two come apart under
 * Socket.IO's `connectionStateRecovery` (server/socket.ts), which reuses a
 * socket id across a recovered reconnection. The disconnect removes the id and
 * takes a single-tab User offline; the recovery then re-registers that same
 * id. Reporting "no transition" because the id looked familiar would leave
 * that User shown offline while they are connected, until something unrelated
 * moved their Presence again.
 */
export interface PresenceRegistry {
  /**
   * Records a live connection. Returns true when this brought the User online
   * -- their first connection -- so the caller broadcasts only on a real
   * transition rather than every time somebody opens a tab.
   */
  connected: (userId: string, connectionId: string) => boolean;
  /**
   * Drops a connection. Returns true when this took the User offline -- their
   * last connection -- and false while any other tab still holds one.
   */
  disconnected: (userId: string, connectionId: string) => boolean;
  /** Whether a User holds at least one live connection. */
  isOnline: (userId: string) => boolean;
  /** The Users currently online. Exposed for tests and diagnostics. */
  trackedUsers: () => string[];
}

export function createPresenceRegistry(): PresenceRegistry {
  const connectionsByUser = new Map<string, Set<string>>();

  return {
    connected(userId, connectionId) {
      const held = connectionsByUser.get(userId);
      if (!held) {
        connectionsByUser.set(userId, new Set([connectionId]));
        return true;
      }
      held.add(connectionId);
      return false;
    },

    disconnected(userId, connectionId) {
      const held = connectionsByUser.get(userId);
      // A disconnection for a connection never registered changes nothing --
      // it must not be allowed to take a User offline who is still connected.
      if (!held?.delete(connectionId)) return false;

      if (held.size > 0) return false;

      // Removed rather than left as an empty set: an offline User is the
      // absence of an entry, so a long-running process does not accumulate a
      // row for every User who has ever connected to it.
      connectionsByUser.delete(userId);
      return true;
    },

    isOnline(userId) {
      return connectionsByUser.has(userId);
    },

    trackedUsers() {
      return [...connectionsByUser.keys()];
    },
  };
}
