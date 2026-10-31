import { createQueue } from "../shared/queue.ts";
import type { SanitizedAction } from "./storage.ts";
import type { Sender } from "./sender.ts";
import type { Store } from "./store.ts";

export interface Dispatcher {
  dispatch(action: SanitizedAction, dispatchId?: number): Promise<boolean>;
  refresh(): Promise<void>;
}

export interface DispatcherParams {
  signal: AbortSignal;
  store: Store;
  sender: Sender;
  onDispatchError: (error: unknown) => void;
  onDispatched: () => void;
}

export function createDispatcher({
  signal,
  store,
  sender,
  onDispatchError,
  onDispatched,
}: DispatcherParams): Dispatcher {
  const dispatchQueue = createQueue(signal);

  return {
    dispatch,
    refresh,
  };

  function dispatch(action: SanitizedAction, dispatchId?: number): Promise<boolean> {
    return dispatchQueue.run(async () => {
      try {
        // The store owns the OPFS lock: it mints the HLC timestamp, appends to
        // the outbox, persists everything, and updates the local (optimistic)
        // state in one transaction.
        await store.dispatch(action, dispatchId);
        // Wake the sender to send the new action
        sender.wake();
        // Notify other tabs so they can refresh their in-memory state
        onDispatched();
        return true;
      } catch (err) {
        console.error(err);
        onDispatchError(err);
        return false;
      }
    });
  }

  function refresh(): Promise<void> {
    return dispatchQueue.run(async () => {
      try {
        await store.refreshFromOpfs();
      } catch (err) {
        console.error(err);
      }
    });
  }
}
