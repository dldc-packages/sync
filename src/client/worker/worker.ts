import type { TStoreReducer } from "../../shared/types.ts";
import { createApiClient } from "./api.ts";
import { createDispatcher } from "./dispatcher.ts";
import { init } from "./init.ts";
import type { OpfsClient, StoredError, TDebugState } from "./opfs.ts";
import { createSender } from "./sender.ts";
import { createStore } from "./store.ts";
import { createSyncer } from "./syncer.ts";
import { decodeMessage, encodeMessage } from "./transport.ts";
import type {
  TGetContext,
  TRestoreContext,
  TSanitizeContext,
  TWorkerInMessage,
  TWorkerOutMessage,
} from "./types.ts";

export type TWorkerMessageHandler = (message: MessageEvent) => void;

export interface TWorkerEngine {
  handleMessage: TWorkerMessageHandler;
  start(): void;
}

export interface TWorkerEngineParams<Action, Context> {
  reducer: TStoreReducer<Action, Context>;
  getContext: TGetContext<Context>;
  sanitizeContext: TSanitizeContext<Context>;
  restoreContext: TRestoreContext<Context>;
  syncPath: (clientId: string) => string;
  dispatchPath: (clientId: string) => string;
  crossTabDispatchChannelName: string;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  dbFileName: string;
  stateFileName: string;
  maxStoredErrors: number;
  sendLockName: string;
  opfsLockName: string;
  getContextTimeoutMs: number;
}

export function createWorkerEngine<Action, Context>(
  {
    reducer,
    getContext,
    restoreContext,
    sanitizeContext,
    syncPath,
    dispatchPath,
    reconnectBaseDelay,
    reconnectMaxDelay,
    crossTabDispatchChannelName,
    dbFileName,
    stateFileName,
    maxStoredErrors,
    sendLockName,
    opfsLockName,
    getContextTimeoutMs,
  }: TWorkerEngineParams<Action, Context>,
): TWorkerEngine {
  const syncController = new AbortController();

  let debugState: TDebugState = { pendingCount: 0, errors: [] };
  let sessionExpired = false;

  let handleMessage = (message: TWorkerInMessage<Action>) => {
    if (message.kind === "Terminate") {
      syncController.abort();
      self.close();
      return;
    }
  };

  return {
    handleMessage(event: MessageEvent) {
      handleMessage(decodeMessage(event.data) as TWorkerInMessage<Action>);
    },
    start,
  };

  function start(): void {
    main().catch((err) => {
      console.error(err);
      handleError(null, "Startup", err);
    });
  }

  function sendMessage(message: TWorkerOutMessage<Context>): void {
    const [data, transfer] = encodeMessage(message);
    self.postMessage(data, transfer);
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
    opfsClient: OpfsClient<Action, Context> | null,
    kind: StoredError["kind"],
    error: unknown,
    dedupKey?: string,
  ): Promise<void> {
    const message = error instanceof Error
      ? error.message.split("\n")[0]
      : String(error).split("\n")[0];
    const stack = error instanceof Error
      ? (error.stack ?? String(error))
      : String(error);
    try {
      if (opfsClient) {
        const state = await opfsClient.addError(
          kind,
          message,
          stack,
          dedupKey ?? message,
        );
        updateDebugState(state);
      }
    } catch (err) {
      console.error("[handleError] Failed to store error:", err);
    }
  }

  async function main() {
    const initState = await init<Action, Context>({
      onNoContextError: () => {
        handleError(null, "Startup", "No context available");
      },
      onUnauthorized: handleSessionExpired,
      getContext,
      restoreContext,
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
      database,
      context,
      opfsClient,
      clientId,
      pending,
      errors,
      serverVersion,
    } = initState;

    // Initialize debug state from the loaded OPFS state
    debugState = { pendingCount: pending.length, errors };

    const apiClient = createApiClient<Action>({
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
      onDatabase: (content: Uint8Array) => {
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

    handleMessage = (message: TWorkerInMessage<Action>) => {
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

    sendMessage({
      kind: "Ready",
      context,
      database: store.getLocalContent().slice().buffer,
    });

    // Send initial debug state to the main thread
    sendDebugState();
  }
}
