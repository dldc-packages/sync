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
import type { OpfsClient, StoredError, TDebugState } from "./opfs.ts";
import { createSender } from "./sender.ts";
import { createStore } from "./store.ts";
import { createSyncer } from "./syncer.ts";
import type { TWorkerInMessage, TWorkerOutMessage } from "./types.ts";

export type TWorkerMessageHandler = (message: MessageEvent) => void;

export interface TWorkerEngine {
  handleMessage: TWorkerMessageHandler;
  start(): void;
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
   * main thread receives), once with the initial content on startup. Only
   * valid for the duration of the call — copy it if it must be retained
   * beyond the next emission. */
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

export function createWorkerEngine<Action, Context>({
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
}: TWorkerEngineParams<Action, Context>): TWorkerEngine {
  const syncController = new AbortController();

  let debugState: TDebugState = { pendingCount: 0, errors: [] };
  let sessionExpired = false;

  let handleMessage = (message: TWorkerInMessage) => {
    if (message.kind === "Terminate") {
      syncController.abort();
      self.close();
      return;
    }
  };

  return {
    handleMessage(event: MessageEvent) {
      handleMessage(event.data as TWorkerInMessage);
    },
    start,
  };

  function start(): void {
    main().catch((err) => {
      console.error(err);
      handleError(null, "Startup", err);
    });
  }

  function sendMessage(message: TWorkerOutMessage): void {
    self.postMessage(message, getTransferable(message));
  }

  function getTransferable(message: TWorkerOutMessage): Transferable[] {
    if (message.kind === "Ready") {
      return [message.database];
    }
    if (message.kind === "Database") {
      return [message.content];
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

    const store = createStore<Action, Context>({
      context,
      initialDatabase: database,
      initialPending: pending,
      initialServerVersion: serverVersion,
      opfsClient,
      restoreAction,
      onDatabase: (content: Uint8Array) => {
        // In-process hook first; the message path slices before transferring,
        // so the hook's reference is never detached.
        onDatabase?.(content);
        sendMessage({ kind: "Database", content: content.slice().buffer });
      },
      onStateChange: (pendingCount: number) => {
        debugState = { ...debugState, pendingCount };
        sendDebugState();
      },
      reducer,
    });

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
      store,
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
      store,
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

    handleMessage = (message: TWorkerInMessage) => {
      if (message.kind === "Terminate") {
        broadcastChannel.close();
        syncController.abort();
        self.close();
        return;
      }
      if (message.kind === "Dispatch") {
        dispatcher.dispatch(message.action);
        return;
      }
      if (message.kind === "ClearError") {
        opfsClient.clearError(message.id).then(updateDebugState);
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
      message satisfies never;
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
