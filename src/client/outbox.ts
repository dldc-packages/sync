import type { TRestoreAction } from "../shared/types.ts";
import type { SanitizedOutboxAction } from "./storage.ts";
import type { OutboxAction } from "./types.ts";

export interface SetOutboxResult<Action> {
  appended: OutboxAction<Action>[] | null;
}

export interface OutboxStore<Action> {
  getOutbox(): OutboxAction<Action>[];
  setOutbox(sanitized: SanitizedOutboxAction[]): SetOutboxResult<Action>;
}

export function createOutboxStore<Action>(
  initialOutbox: SanitizedOutboxAction[],
  restoreAction: TRestoreAction<Action>,
): OutboxStore<Action> {
  let outboxCache = new Map<string, OutboxAction<Action>>();
  let outbox = initialOutbox.map((action) => {
    const restored = restoreOutboxAction(action);
    outboxCache.set(action.ts, restored);
    return restored;
  });

  return {
    getOutbox,
    setOutbox,
  };

  function getOutbox(): OutboxAction<Action>[] {
    return outbox;
  }

  /**
   * Given a new sanitized outbox list, update the internal cache and return the
   * new OutboxAction list.
   */
  function setOutbox(sanitized: SanitizedOutboxAction[]): SetOutboxResult<Action> {
    const appended = appendedOutbox(outbox, sanitized);
    if (appended !== null) {
      appended.forEach((action) => {
        const restored = restoreOutboxAction(action);
        outboxCache.set(action.ts, restored);
        outbox.push(restored);
      });
      return { appended: outbox.slice(-appended.length) };
    }
    // Fallback: rebuild the entire outbox list from scratch
    const nextCache = new Map<string, OutboxAction<Action>>();
    const nextOutbox = sanitized.map((action) => {
      const cache = outboxCache.get(action.ts);
      if (cache) {
        nextCache.set(action.ts, cache);
        return cache;
      }
      const restored = restoreOutboxAction(action);
      nextCache.set(action.ts, restored);
      return restored;
    });
    outboxCache = nextCache;
    outbox = nextOutbox;
    return { appended: null };
  }

  function restoreOutboxAction(sanitized: SanitizedOutboxAction): OutboxAction<Action> {
    return {
      ts: sanitized.ts,
      action: restoreAction(sanitized.action._action),
    };
  }

  /**
   * If `next` is exactly `prev` with extra actions appended (prev is a prefix,
   * matched by ts), return the appended tail. Otherwise return null.
   */
  function appendedOutbox(
    prev: OutboxAction<Action>[],
    next: SanitizedOutboxAction[],
  ): SanitizedOutboxAction[] | null {
    if (next.length < prev.length) return null;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].ts !== next[i].ts) return null;
    }
    return next.slice(prev.length);
  }
}
