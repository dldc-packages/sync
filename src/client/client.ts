import {
  createSubscription,
  type TSubscriptionCallback,
  type TUnsubscribe,
} from "@dldc/pubsub";
import { createDeferred, type TDeferred } from "../shared/deferred.ts";
import type { TDebugState } from "./opfs.ts";
import { decodeMessage, encodeMessage } from "./transport.ts";
import type { TWorkerInMessage, TWorkerOutMessage } from "./types.ts";

export interface WorkerClient<Action, Context> {
  ready(): Promise<void>;
  subscribeDatabase(
    callback: TSubscriptionCallback<Uint8Array>,
  ): TUnsubscribe;
  subscribeDebugState(
    callback: TSubscriptionCallback<TDebugState>,
  ): TUnsubscribe;
  getDatabase(): Uint8Array;
  getDatabaseVersion(): number;
  getContext(): Context;
  getDebugState(): TDebugState;
  dispatch(action: Action): void;
  clearError(id: string): void;
  clearAllErrors(): void;
  refresh(): void;
  forceRefresh(): void;
  stop(): void;
}

interface TWorkerInternalState<Context> {
  version: number;
  database: Uint8Array;
  context: Context;
  debugState: TDebugState;
}

export function createWorkerClient<Action, Context>(
  worker: Worker,
): WorkerClient<Action, Context> {
  const databaseSubscriptions = createSubscription<Uint8Array>();
  const debugStateSubscriptions = createSubscription<TDebugState>();

  let state: TWorkerInternalState<Context> | null = null;
  let isReady: TDeferred<void> | null = createDeferred<void>();

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (!message.kind) {
      return;
    }
    handleOutMessage(decodeMessage(message) as TWorkerOutMessage<Context>);
  };

  return {
    subscribeDatabase: databaseSubscriptions.subscribe,
    subscribeDebugState: debugStateSubscriptions.subscribe,
    ready,
    getDatabase,
    getDatabaseVersion,
    getContext,
    getDebugState,
    dispatch,
    clearError,
    clearAllErrors,
    refresh,
    forceRefresh,
    stop,
  };

  function getDatabaseVersion(): number {
    if (state === null) {
      throw new Error("Worker not ready");
    }
    return state.version;
  }

  function ready(): Promise<void> {
    if (isReady === null) {
      return Promise.resolve();
    }
    return isReady.promise;
  }

  function getDatabase(): Uint8Array {
    if (state === null) {
      throw new Error("Worker not ready");
    }
    return state.database;
  }

  function getContext(): Context {
    if (state === null) {
      throw new Error("Worker not ready");
    }
    return state.context;
  }

  function getDebugState(): TDebugState {
    if (state === null) {
      throw new Error("Worker not ready");
    }
    return state.debugState;
  }

  function stop(): void {
    sendMessage({ kind: "Terminate" });
  }

  function dispatch(action: Action): void {
    sendMessage({ kind: "Dispatch", action });
  }

  function clearError(id: string): void {
    sendMessage({ kind: "ClearError", id });
  }

  function clearAllErrors(): void {
    sendMessage({ kind: "ClearAllErrors" });
  }

  function refresh(): void {
    sendMessage({ kind: "Refresh" });
  }

  function forceRefresh(): void {
    sendMessage({ kind: "ForceRefresh" });
  }

  function sendMessage(message: TWorkerInMessage<Action>): void {
    const [data, transfer] = encodeMessage(message);
    worker.postMessage(data, transfer);
  }

  function handleOutMessage(message: TWorkerOutMessage<Context>) {
    if (message.kind === "Ready") {
      if (isReady !== null) {
        isReady.resolve();
        isReady = null;
      }
      if (state !== null) {
        throw new Error("Worker already initialized");
      }
      state = {
        version: 1,
        database: new Uint8Array(message.database),
        context: message.context,
        debugState: { pendingCount: 0, errors: [] },
      };
      databaseSubscriptions.emit(state.database);
      return;
    }
    if (message.kind === "Database") {
      if (state === null) {
        throw new Error("Worker not ready");
      }
      state.database = new Uint8Array(message.content);
      state.version++;
      databaseSubscriptions.emit(state.database);
      return;
    }
    if (message.kind === "DebugState") {
      if (state === null) {
        throw new Error("Worker not ready");
      }
      state.debugState = {
        pendingCount: message.pendingCount,
        errors: message.errors,
      };
      debugStateSubscriptions.emit(state.debugState);
      return;
    }
    if (message.kind === "Reload") {
      globalThis.location.reload();
      return;
    }
    if (message.kind === "SessionExpired") {
      forceServerReload();
      return;
    }

    message satisfies never;
  }
}

let forceReloading = false;

export async function forceServerReload(): Promise<void> {
  if (forceReloading) return;
  forceReloading = true;
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in globalThis) {
      const keys = await globalThis.caches.keys();
      await Promise.all(keys.map((k) => globalThis.caches.delete(k)));
    }
  } catch {
    // ignore — still force the navigation below
  }
  globalThis.location.replace(globalThis.location.pathname);
}
