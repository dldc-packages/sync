import type { TRestoreAction } from "../shared/types.ts";
import type { SanitizedPendingAction } from "./opfs.ts";
import type { PendingAction } from "./types.ts";

export interface SetPendingsResult<Action> {
  appended: PendingAction<Action>[] | null;
}

export interface PendingStore<Action> {
  getPendings(): PendingAction<Action>[];
  setPendings(sanitized: SanitizedPendingAction[]): SetPendingsResult<Action>;
}

export function createPendingStore<Action>(
  initialPending: SanitizedPendingAction[],
  restoreAction: TRestoreAction<Action>,
): PendingStore<Action> {
  let pendingCache = new Map<string, PendingAction<Action>>();
  let pendings = initialPending.map((action) => {
    const restored = restorePending(action);
    pendingCache.set(action.ts, restored);
    return restored;
  });

  return {
    getPendings,
    setPendings,
  };

  function getPendings(): PendingAction<Action>[] {
    return pendings;
  }

  /**
   * Given a new sanitized pending list, update the internal cache and return the new PendingAction list.
   * @returns
   */
  function setPendings(sanitized: SanitizedPendingAction[]): SetPendingsResult<Action> {
    const appended = appendedPending(pendings, sanitized);
    if (appended !== null) {
      appended.forEach((pending) => {
        const restored = restorePending(pending);
        pendingCache.set(pending.ts, restored);
        pendings.push(restored);
      });
      return { appended: pendings.slice(-appended.length) };
    }
    // Fallback: rebuild the entire pending list from scratch
    const nextCache = new Map<string, PendingAction<Action>>();
    const nextPending = sanitized.map((pending) => {
      const cache = pendingCache.get(pending.ts);
      if (cache) {
        nextCache.set(pending.ts, cache);
        return cache;
      }
      const restored = restorePending(pending);
      nextCache.set(pending.ts, restored);
      return restored;
    });
    pendingCache = nextCache;
    pendings = nextPending;
    return { appended: null };
  }

  function restorePending(sanitized: SanitizedPendingAction): PendingAction<Action> {
    return {
      ts: sanitized.ts,
      action: restoreAction(sanitized.action._action),
    };
  }

  /**
   * If `next` is exactly `prev` with extra actions appended (prev is a prefix,
   * matched by ts), return the appended tail. Otherwise return null.
   */
  function appendedPending(
    prev: PendingAction<Action>[],
    next: SanitizedPendingAction[],
  ): SanitizedPendingAction[] | null {
    if (next.length < prev.length) return null;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].ts !== next[i].ts) return null;
    }
    return next.slice(prev.length);
  }
}
