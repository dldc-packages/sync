import { createQueue } from "../shared/queue.ts";
import type { OpfsClient, SanitizedAction } from "./opfs.ts";
import type { Sender } from "./sender.ts";
import type { Store } from "./store.ts";

export interface Dispatcher {
  dispatch(action: SanitizedAction): Promise<void>;
  refresh(): Promise<void>;
}

export interface DispatcherParams<Action> {
  signal: AbortSignal;
  store: Store<Action>;
  sender: Sender;
  opfsClient: OpfsClient;
  onDispatchError: (error: unknown) => void;
  onDispatched: () => void;
}

export function createDispatcher<Action>(
  { signal, store, sender, opfsClient, onDispatchError, onDispatched }:
    DispatcherParams<Action>,
): Dispatcher {
  const dispatchQueue = createQueue(signal);

  return {
    dispatch,
    refresh,
  };

  function dispatch(action: SanitizedAction): Promise<void> {
    return dispatchQueue.run(async () => {
      try {
        // Inside the lock: read state, generate TS, add to pending,
        // check if DB changed (another tab), save state, return results.
        const result = await opfsClient.dispatchInLock(
          action,
          store.getServerVersion(),
        );
        store.applyDispatchResult(result);
        // Wake the sender to send the new action
        sender.wake();
        // Notify other tabs so they can refresh their in-memory state
        onDispatched();
      } catch (err) {
        console.error(err);
        onDispatchError(err);
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
