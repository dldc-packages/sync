import type {
  TGetContext,
  TGetDerive,
  TGetStoreReducer,
  TRestoreAction,
  TRestoreContext,
  TSanitizeContext,
} from "../shared/types.ts";
import { createApiClient } from "./api.ts";
import { createDispatcher } from "./dispatcher.ts";
import { init } from "./init.ts";
import { createSender } from "./sender.ts";
import type { StoredError, TDebugState } from "./storage.ts";
import { createStore, type Store } from "./store.ts";
import { createSyncer } from "./syncer.ts";
import type { TWorkerInMessage, TWorkerOutMessage } from "./types.ts";

export interface TWorkerEngine {
  /**
   * Feed a main→worker message into the engine. The host wires this to the
   * worker global's `message` event (e.g. `self.addEventListener("message",
   * (e) => engine.receive(e.data))`) — the engine owns no listener itself, so
   * your own protocol can share the same worker. Messages without a `kind`
   * string are ignored.
   */
  receive(message: TWorkerInMessage): void;
  start(): void;
}

export interface TWorkerEngineParams<Action, Context> {
  /**
   * Post a worker→main message. The host wires this to `self.postMessage` and
   * MUST forward `transfer`: the engine computes the transfer list (always a
   * real array, empty when nothing is transferable) so the `Ready`/`Database`
   * database buffers are transferred — not cloned — to the main thread. The
   * parameter is non-optional precisely so this forward can't be dropped by
   * accident (e.g. `emit: (message, transfer) => self.postMessage(message,
   * transfer)`).
   */
  emit: (message: TWorkerOutMessage, transfer: Transferable[]) => void;
  /**
   * Close the worker scope (e.g. `() => self.close()`). Called when the main
   * thread sends `Terminate`. The engine itself never touches the worker
   * global.
   */
  close: () => void;
  crossTabDispatchChannelName: string;
  stateFileName: string;
  dispatchPath: (clientId: string) => string;
  getContext: TGetContext<Context>;
  getContextTimeoutMs: number;
  getReducer: TGetStoreReducer<Action, Context>;
  /**
   * Recompute the derived value for the committed server content. Derived is
   * always on — `getDerive` and `derivedFileName` are required, on the client
   * and server alike, and the same `derive` must run on both sides (see README).
   */
  getDerive: TGetDerive;
  maxStoredErrors: number;
  /** OPFS file holding the engine bookkeeping (clientId, hlc, outbox, …). */
  metaFileName: string;
  /** Called in-process with every database content change (same content the
   * main thread receives), once with the initial content on startup. Only
   * valid for the duration of the call — copy it if it must be retained
   * beyond the next emission. */
  onDatabase?: (content: Uint8Array) => void;
  /** Called in-process with every derived change (same bytes the main thread
   * receives via `subscribeDerived`), once with the initial derived on
   * startup. Only valid for the duration of the call. */
  onDerived?: (derived: Uint8Array) => void;
  opfsLockName: string;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  restoreAction: TRestoreAction<Action>;
  sanitizeContext: TSanitizeContext<Context>;
  restoreContext: TRestoreContext<Context>;
  sendLockName: string;
  syncPath: (clientId: string) => string;
  /** OPFS file holding the derived value (always configured — derived is always on). */
  derivedFileName: string;
  /**
   * Escape hatch for large derived values. Derived is always computed and the
   * in-process `onDerived` hook always fires. By default every `Ready`/
   * `Database` message also carries the derived bytes to the main thread
   * (each emission costs a `slice()` copy; the transfer itself is O(1) —
   * zero-copy). Set `emitDerived: false` to skip that per-snapshot copy:
   * only the initial derived (in `Ready`) is delivered, later snapshots
   * arrive without an updated derived. The main thread's `getDerived()` is
   * never null — it just keeps the last delivered value.
   */
  emitDerived?: boolean;
}

export function createWorkerEngine<Action, Context>({
  emit,
  close,
  crossTabDispatchChannelName,
  stateFileName,
  dispatchPath,
  getContext,
  getContextTimeoutMs,
  getReducer,
  getDerive,
  maxStoredErrors,
  metaFileName,
  onDatabase,
  onDerived,
  opfsLockName,
  reconnectBaseDelay,
  reconnectMaxDelay,
  restoreAction,
  restoreContext,
  sanitizeContext,
  sendLockName,
  syncPath,
  derivedFileName,
  emitDerived = true,
}: TWorkerEngineParams<Action, Context>): TWorkerEngine {
  const syncController = new AbortController();

  let debugState: TDebugState = { outboxCount: 0, errors: [] };
  let sessionExpired = false;

  // Incoming (main→worker) messages. Before `main()` has built the store,
  // syncer, sender and dispatcher, the engine can only react to Terminate; the
  // full message handling below replaces (`receiveMessage`) this closure then.
  let receiveMessage = (message: TWorkerInMessage) => {
    if (message.kind === "Terminate") {
      syncController.abort();
      close();
      return;
    }
  };

  return {
    receive,
    start,
  };

  function start(): void {
    main().catch((err) => {
      console.error(err);
      handleError(null, "Startup", err);
    });
  }

  /**
   * Feed a main→worker message into the engine (see `TWorkerEngine.receive`).
   * Anything that is not a sync message is left for the app's own handlers.
   */
  function receive(message: TWorkerInMessage): void {
    // The host may hand this any `event.data` (even non-objects) when the app
    // shares the worker global with its own protocol, so guard loosely.
    const candidate = message as unknown;
    const kind = (candidate as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string") {
      return;
    }
    receiveMessage(message);
  }

  function sendMessage(message: TWorkerOutMessage): void {
    emit(message, getTransferable(message));
  }

  function getTransferable(message: TWorkerOutMessage): Transferable[] {
    if (message.kind === "Ready") {
      return [message.database, ...(message.derived ? [message.derived] : [])];
    }
    if (message.kind === "Database") {
      return [message.content, ...(message.derived ? [message.derived] : [])];
    }
    return [];
  }

  function handleSessionExpired(): void {
    if (sessionExpired) return;
    sessionExpired = true;
    syncController.abort();
    sendMessage({ kind: "SessionExpired" });
  }

  function sendDebugState(): void {
    sendMessage({ kind: "DebugState", ...debugState });
  }

  function updateDebugState(state: TDebugState): void {
    debugState = state;
    sendDebugState();
  }

  async function handleError(
    store: Store | null,
    kind: StoredError["kind"],
    error: unknown,
    dedupKey?: string,
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message.split("\n")[0] : String(error).split("\n")[0];
    const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error);
    try {
      if (store) {
        const state = await store.addError(kind, message, stack, dedupKey ?? message);
        updateDebugState(state);
      }
    } catch (err) {
      console.error("[handleError] Failed to store error:", err);
    }
  }

  async function main() {
    const initState = await init<Action, Context>({
      getReducer,
      getDerive,
      onNoContextError: () => {
        handleError(null, "Startup", "No context available");
      },
      onUnauthorized: handleSessionExpired,
      getContext,
      sanitizeContext,
      stateFileName,
      metaFileName,
      getContextTimeoutMs,
      opfsLockName,
      derivedFileName,
    });
    if (!initState || syncController.signal.aborted) {
      return;
    }

    const {
      reducer,
      derive: loadedDerive,
      database,
      context: sanitizedContext,
      storage,
      clientId,
      outbox,
      errors,
      serverVersion,
      derived: initialDerived,
    } = initState;

    const context = restoreContext(sanitizedContext._context);

    // Initialize debug state from the loaded OPFS bookkeeping
    debugState = { outboxCount: outbox.length, errors };

    const apiClient = createApiClient({
      syncPath,
      dispatchPath,
      reconnectBaseDelay,
      reconnectMaxDelay,
      onUnauthorized: handleSessionExpired,
    });

    const store = createStore<Action, Context>({
      context,
      storage,
      opfsLockName,
      maxStoredErrors,
      initialState: database,
      initialOutbox: outbox,
      initialServerVersion: serverVersion,
      initialDerived,
      restoreAction,
      derive: loadedDerive,
      onState: (content: Uint8Array, derivedContent: Uint8Array, dispatchedId?: number) => {
        // In-process hooks first; the message path slices before transferring,
        // so the hooks' references are never detached.
        onDatabase?.(content);
        onDerived?.(derivedContent);
        sendMessage({
          kind: "Database",
          content: content.slice().buffer,
          ...(emitDerived ? { derived: derivedContent.slice().buffer } : {}),
          ...(dispatchedId === undefined ? {} : { dispatchedId }),
        });
      },
      onStateChange: (outboxCount: number) => {
        debugState = { ...debugState, outboxCount };
        sendDebugState();
      },
      reducer,
    });

    const sender = createSender({
      apiClient,
      clientId,
      store,
      signal: syncController.signal,
      sendLockName,
      onExhausted: (action) => {
        handleError(
          store,
          "Send",
          `Failed to send action after retries (ts: ${action.ts})`,
          action.ts,
        );
      },
      onUnauthorized: handleSessionExpired,
    });

    createSyncer({
      signal: syncController.signal,
      clientId,
      store,
      apiClient,
      onPatchError: (version, error) => {
        handleError(store, "Sync", error, version);
      },
    });

    const broadcastChannel = new BroadcastChannel(crossTabDispatchChannelName);

    const dispatcher = createDispatcher({
      store,
      sender,
      signal: syncController.signal,
      onDispatchError: (error: unknown) => {
        handleError(store, "Dispatch", error);
      },
      onDispatched: () => {
        broadcastChannel.postMessage("dispatch");
      },
    });

    broadcastChannel.onmessage = () => {
      dispatcher.refresh();
    };

    receiveMessage = (message: TWorkerInMessage) => {
      if (message.kind === "Terminate") {
        broadcastChannel.close();
        syncController.abort();
        close();
        return;
      }
      if (message.kind === "Dispatch") {
        dispatcher.dispatch(message.action, message.id).then(
          (ok) => {
            if (message.ack) {
              sendMessage({ kind: "Dispatched", id: message.id!, ok });
            }
          },
          () => {
            // Queue aborted (e.g. session expired while shutting down).
            if (message.ack) {
              sendMessage({ kind: "Dispatched", id: message.id!, ok: false });
            }
          },
        );
        return;
      }
      if (message.kind === "ClearError") {
        store.clearError(message.id).then(updateDebugState);
        return;
      }
      if (message.kind === "ClearAllErrors") {
        store.clearAllErrors().then(updateDebugState);
        return;
      }
      if (message.kind === "Refresh") {
        store.refresh().then(() => {
          sendMessage({ kind: "Reload" });
        });
        return;
      }
      if (message.kind === "ForceRefresh") {
        store.forceRefresh().then(() => {
          sendMessage({ kind: "Reload" });
        });
        return;
      }
      // Unknown kinds are ignored. This keeps the protocol open: an app sharing
      // this worker handles its own `{ kind }` messages in its own event
      // listeners.
    };

    // Emit the initial content to the in-process hooks (the store's onState
    // only fires on later changes), mirroring the Ready message below.
    const readyDerived = store.getDerived();
    onDatabase?.(store.getState());
    onDerived?.(readyDerived);

    // Ready always carries the initial derived, so the main thread's
    // `getDerived()` is non-null even when `emitDerived` is false.
    sendMessage({
      kind: "Ready",
      context: sanitizedContext,
      database: store.getState().slice().buffer,
      derived: readyDerived.slice().buffer,
    });

    // Send initial debug state to the main thread
    sendDebugState();
  }
}
