import type {
  TGetContext,
  TGetStoreReducer,
  TRestoreAction,
  TRestoreContext,
  TSanitizeContext,
} from "../shared/types.ts";
import { createApiClient } from "./api.ts";
import { createDispatcher } from "./dispatcher.ts";
import { init } from "./init.ts";
import {
  createMessageRouter,
  getMessageTransferables,
  type TMessageBus,
  type TMessageRouter,
  type TWorkerMessage,
} from "./messageBus.ts";
import type { OpfsClient, StoredError, TDebugState } from "./opfs.ts";
import { createSender } from "./sender.ts";
import { createStore, type Store } from "./store.ts";
import { createSyncer } from "./syncer.ts";
import type { TWorkerInMessage, TWorkerOutMessage } from "./types.ts";

export type TWorkerMessageHandler = (message: MessageEvent) => void;

/** The worker-side sync engine with no transport attached: it owns the local
 * OPFS copy, the reducer, the sync and send loops and the dispatcher, and
 * exchanges messages through a `TMessageBus` — `emit` for main→worker messages,
 * `onMessage` for worker→main ones. The bus is open (`kind` strings), so
 * app-specific protocols could share the same endpoint; in practice the
 * transport's router is where they live. */
export interface TWorkerEngineCore extends TMessageBus {
  start(): void;
  /**
   * The latest local state (server content with the optimistic pending actions
   * applied) — the same snapshot `onDatabase` receives and the `Ready`/
   * `Database` messages carry. The returned buffer is never mutated or
   * transferred after it is produced, so a reference can be kept (and read
   * across an await) with no copy. Returns `null` before the engine has
   * initialized.
   */
  getState(): Uint8Array | null;
}

/** The worker scope a transport writes to. A `DedicatedWorkerGlobalScope`
 * satisfies it; kept minimal so transports are easy to construct in tests. */
export interface TWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** The complete worker engine: a core over which a transport has been layered.
 * `handleMessage` keeps the established "assign me to `self.onmessage`"
 * pattern, `send` posts any protocol's message to the main thread, and `router`
 * lets the app EXTEND the transport with its own kinds without touching the
 * message plumbing. */
export interface TWorkerEngine extends TWorkerEngineCore {
  handleMessage: TWorkerMessageHandler;
  /** Post a message to the main thread. The database buffers of `Ready`/
   * `Database` messages are transferred automatically; pass `transfer`
   * explicitly only for buffers you sliced yourself. */
  send(message: TWorkerMessage, transfer?: Transferable[]): void;
  /** Route main→worker messages by kind. The default transport already routes
   * its own kinds (`Dispatch`, `Terminate`, …); register your own protocol
   * kinds here so they ride the same single listener. */
  router: TMessageRouter;
}

export interface TWorkerEngineParams<Action, Context> {
  crossTabDispatchChannelName: string;
  dbFileName: string;
  dispatchPath: (clientId: string) => string;
  getContext: TGetContext<Context>;
  getContextTimeoutMs: number;
  getReducer: TGetStoreReducer<Action, Context>;
  maxStoredErrors: number;
  /** Called in-process with every database content change (same content the
   * main thread receives), once with the initial content on startup. The
   * buffers handed here are never mutated or transferred afterwards, so they
   * may be retained (see `getState`). */
  onDatabase?: (content: Uint8Array) => void;
  opfsLockName: string;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  restoreAction: TRestoreAction<Action>;
  sanitizeContext: TSanitizeContext<Context>;
  restoreContext: TRestoreContext<Context>;
  sendLockName: string;
  stateFileName: string;
  syncPath: (clientId: string) => string;
}

export function createWorkerEngineCore<Action, Context>(
  params: TWorkerEngineParams<Action, Context>,
): TWorkerEngineCore {
  const {
    crossTabDispatchChannelName,
    dbFileName,
    dispatchPath,
    getContext,
    getContextTimeoutMs,
    getReducer,
    maxStoredErrors,
    onDatabase,
    opfsLockName,
    reconnectBaseDelay,
    reconnectMaxDelay,
    restoreAction,
    restoreContext,
    sanitizeContext,
    sendLockName,
    stateFileName,
    syncPath,
  } = params;

  const syncController = new AbortController();

  let debugState: TDebugState = { pendingCount: 0, errors: [] };
  let sessionExpired = false;

  /** Subscribers to the worker→main messages the engine produces. A transport
   * is exactly one such subscriber that posts them to the main thread. */
  const outgoing = new Set<(message: TWorkerMessage) => void>();

  /** The store, once initialized; `getState` reads through it. */
  let store: Store<Action> | null = null;

  // Incoming (main→worker) messages. Before `main()` has built the store,
  // syncer, sender and dispatcher the engine can only react to Terminate; the
  // full message handling below replaces (`emitMessage`) this closure then.
  let emitMessage = (message: TWorkerMessage) => {
    if (message.kind === "Terminate") {
      syncController.abort();
    }
  };

  return {
    emit: (message) => {
      emitMessage(message);
    },
    onMessage: (handler) => {
      outgoing.add(handler);
      return () => {
        outgoing.delete(handler);
      };
    },
    start,
    getState: () => store?.getLocalContent() ?? null,
  };

  function start(): void {
    main().catch((err) => {
      console.error(err);
      handleError(null, "Startup", err);
    });
  }

  function sendMessage(message: TWorkerOutMessage): void {
    for (const handler of outgoing) {
      handler(message);
    }
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
    opfsClient: OpfsClient | null,
    kind: StoredError["kind"],
    error: unknown,
    dedupKey?: string,
  ): Promise<void> {
    const message =
      error instanceof Error ? error.message.split("\n")[0] : String(error).split("\n")[0];
    const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error);
    try {
      if (opfsClient) {
        const state = await opfsClient.addError(kind, message, stack, dedupKey ?? message);
        updateDebugState(state);
      }
    } catch (err) {
      console.error("[handleError] Failed to store error:", err);
    }
  }

  async function main() {
    const initState = await init<Action, Context>({
      getReducer,
      onNoContextError: () => {
        handleError(null, "Startup", "No context available");
      },
      onUnauthorized: handleSessionExpired,
      getContext,
      sanitizeContext,
      dbFileName,
      stateFileName,
      maxStoredErrors,
      opfsLockName,
      getContextTimeoutMs,
    });
    if (!initState || syncController.signal.aborted) {
      return;
    }

    const {
      reducer,
      database,
      context: sanitizedContext,
      opfsClient,
      clientId,
      pending,
      errors,
      serverVersion,
    } = initState;

    const context = restoreContext(sanitizedContext._context);

    // Initialize debug state from the loaded OPFS state
    debugState = { pendingCount: pending.length, errors };

    const apiClient = createApiClient({
      syncPath,
      dispatchPath,
      reconnectBaseDelay,
      reconnectMaxDelay,
      onUnauthorized: handleSessionExpired,
    });

    const createdStore = createStore<Action, Context>({
      context,
      initialDatabase: database,
      initialPending: pending,
      initialServerVersion: serverVersion,
      opfsClient,
      restoreAction,
      onDatabase: (content: Uint8Array, dispatchedId?: number) => {
        // In-process hook first; the message path slices before transferring,
        // so the hook's reference is never detached.
        onDatabase?.(content);
        sendMessage({
          kind: "Database",
          content: content.slice().buffer,
          ...(dispatchedId === undefined ? {} : { dispatchedId }),
        });
      },
      onStateChange: (pendingCount: number) => {
        debugState = { ...debugState, pendingCount };
        sendDebugState();
      },
      reducer,
    });
    store = createdStore;

    const sender = createSender({
      apiClient,
      opfsClient,
      clientId,
      signal: syncController.signal,
      sendLockName,
      onExhausted: (pending) => {
        handleError(
          opfsClient,
          "Send",
          `Failed to send action after retries (ts: ${pending.ts})`,
          pending.ts,
        );
      },
      onUnauthorized: handleSessionExpired,
    });

    createSyncer({
      signal: syncController.signal,
      clientId,
      store: createdStore,
      apiClient,
      onPatchError: (version, error) => {
        handleError(opfsClient, "Sync", error, version);
      },
    });

    const broadcastChannel = new BroadcastChannel(crossTabDispatchChannelName);

    const dispatcher = createDispatcher({
      opfsClient,
      signal: syncController.signal,
      sender,
      store: createdStore,
      onDispatchError: (error: unknown) => {
        handleError(opfsClient, "Dispatch", error);
      },
      onDispatched: () => {
        broadcastChannel.postMessage("dispatch");
      },
    });

    broadcastChannel.onmessage = () => {
      dispatcher.refresh();
    };

    emitMessage = (message: TWorkerMessage) => {
      if (message.kind === "Terminate") {
        broadcastChannel.close();
        syncController.abort();
        return;
      }
      if (message.kind === "Dispatch") {
        const { action, id, ack } = message as unknown as Extract<
          TWorkerInMessage,
          { kind: "Dispatch" }
        >;
        dispatcher.dispatch(action, id).then(
          (ok) => {
            if (ack) {
              sendMessage({ kind: "Dispatched", id: id!, ok });
            }
          },
          () => {
            // Queue aborted (e.g. session expired while shutting down).
            if (ack) {
              sendMessage({ kind: "Dispatched", id: id!, ok: false });
            }
          },
        );
        return;
      }
      if (message.kind === "ClearError") {
        opfsClient
          .clearError((message as Extract<TWorkerInMessage, { kind: "ClearError" }>).id)
          .then(updateDebugState);
        return;
      }
      if (message.kind === "ClearAllErrors") {
        opfsClient.clearAllErrors().then(updateDebugState);
        return;
      }
      if (message.kind === "Refresh") {
        opfsClient.refresh().then(() => {
          sendMessage({ kind: "Reload" });
        });
        return;
      }
      if (message.kind === "ForceRefresh") {
        opfsClient.forceRefresh().then(() => {
          sendMessage({ kind: "Reload" });
        });
        return;
      }
    };

    // Emit the initial content to the in-process hook (the store's onDatabase
    // only fires on later changes), mirroring the Ready message below.
    onDatabase?.(store.getLocalContent());

    sendMessage({
      kind: "Ready",
      context: sanitizedContext,
      database: store.getLocalContent().slice().buffer,
    });

    // Send initial debug state to the main thread
    sendDebugState();
  }
}

/** Lay the worker transport onto a core: connect the scope's `onmessage` to
 * the core (`emit`), the core's outgoing messages to `scope.postMessage`, and
 * hand out the router + `send` so app protocol kinds ride the same single
 * listener. Termination is a host concern, so it belongs here: the core aborts
 * its loops, the scope closes. */
export function createWorkerEngineTransport(
  core: TWorkerEngineCore,
  scope: TWorkerScope = globalThis as unknown as TWorkerScope,
): TWorkerEngine {
  const router = createMessageRouter<TWorkerMessage>();

  router.on(["Dispatch", "ClearError", "ClearAllErrors", "Refresh", "ForceRefresh"], (message) => {
    core.emit(message);
  });
  router.on("Terminate", (message) => {
    core.emit(message);
    scope.close();
  });

  scope.onmessage = (event: MessageEvent) => {
    router.handle(event.data);
  };

  const send = (message: TWorkerMessage, transfer?: Transferable[]): void => {
    scope.postMessage(message, transfer ?? getMessageTransferables(message));
  };

  core.onMessage((message) => {
    send(message);
  });

  return {
    handleMessage: (event: MessageEvent) => {
      router.handle(event.data);
    },
    start: () => core.start(),
    emit: (message: TWorkerMessage) => core.emit(message),
    onMessage: (handler) => core.onMessage(handler),
    getState: () => core.getState(),
    send,
    router,
  };
}

/** The complete worker engine: a transport layered over a core. Equivalent to
 * `createWorkerEngineTransport(createWorkerEngineCore(params))` — split out so
 * apps can reuse the parts (see those two for the layering). */
export function createWorkerEngine<Action, Context>(
  params: TWorkerEngineParams<Action, Context>,
): TWorkerEngine {
  return createWorkerEngineTransport(createWorkerEngineCore<Action, Context>(params));
}
