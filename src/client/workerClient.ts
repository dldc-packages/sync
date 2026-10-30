import { createSubscription, type TSubscriptionCallback, type TUnsubscribe } from "@dldc/pubsub";
import { createDeferred, type TDeferred } from "../shared/deferred.ts";
import type { TRestoreContext, TSanitizeAction } from "../shared/types.ts";
import type { TDebugState } from "./opfs.ts";
import type { TWorkerInMessage, TWorkerOutMessage } from "./types.ts";

export interface WorkerClient<Action, Context> {
  ready(): Promise<void>;
  subscribeDatabase(callback: TSubscriptionCallback<Uint8Array>): TUnsubscribe;
  /**
   * Fires with the id of a dispatch at the exact moment its commit snapshot
   * (the one that contains the action) is ready but not yet delivered.
   *
   * Ordering: by the time this callback runs, `getDatabase()` already returns
   * the commit snapshot, and the callback runs synchronously BEFORE that
   * snapshot reaches `subscribeDatabase` subscribers. So an app with a
   * main-thread optimistic layer can drop its overlay for that action here and
   * the next render reconciles to the authoritative snapshot — no re-apply, no
   * flicker.
   *
   * The id is the one passed to `dispatchAsync(action, id)`.
   */
  subscribeDispatched(callback: TSubscriptionCallback<number>): TUnsubscribe;
  subscribeDebugState(callback: TSubscriptionCallback<TDebugState>): TUnsubscribe;
  getDatabase(): Uint8Array;
  getDatabaseVersion(): number;
  getContext(): Context;
  getDebugState(): TDebugState;
  dispatch(action: Action): void;
  dispatchAsync(action: Action, id?: number): Promise<void>;
  clearError(id: string): void;
  clearAllErrors(): void;
  refresh(): void;
  forceRefresh(): void;
  stop(): void;
  /**
   * Feed a worker→main message into the client. The host wires this to the
   * worker's `message` event (e.g. `worker.addEventListener("message", (e) =>
   * client.receive(e.data))`) — the client owns no listener itself, so your own
   * protocol can share the same worker. Messages without a `kind` string are
   * ignored.
   */
  receive(message: TWorkerOutMessage): void;
}

interface TWorkerInternalState<Context> {
  version: number;
  database: Uint8Array;
  context: Context;
  debugState: TDebugState;
}

export interface TWorkerClientParams<Action, Context> {
  /**
   * Post a main→worker message. The host wires this to the worker's
   * `postMessage` (e.g. `emit: (message) => worker.postMessage(message)`) — the
   * client never touches the `Worker` API itself.
   */
  emit: (message: TWorkerInMessage) => void;
  sanitizeAction: TSanitizeAction<Action>;
  restoreContext: TRestoreContext<Context>;
}

export function createWorkerClient<Action, Context>({
  emit,
  sanitizeAction,
  restoreContext,
}: TWorkerClientParams<Action, Context>): WorkerClient<Action, Context> {
  const databaseSubscriptions = createSubscription<Uint8Array>();
  const dispatchedSubscriptions = createSubscription<number>();
  const debugStateSubscriptions = createSubscription<TDebugState>();

  let state: TWorkerInternalState<Context> | null = null;
  let isReady: TDeferred<void> | null = createDeferred<void>();
  let dispatchSeq = 0;
  const pendingDispatches = new Map<
    number,
    { resolve: () => void; reject: (reason: unknown) => void }
  >();

  return {
    subscribeDatabase: databaseSubscriptions.subscribe,
    subscribeDispatched: dispatchedSubscriptions.subscribe,
    subscribeDebugState: debugStateSubscriptions.subscribe,
    ready,
    getDatabase,
    getDatabaseVersion,
    getContext,
    getDebugState,
    dispatch,
    dispatchAsync,
    clearError,
    clearAllErrors,
    refresh,
    forceRefresh,
    stop,
    receive,
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
    rejectAllPendingDispatches(new Error("Worker stopped"));
    sendMessage({ kind: "Terminate" });
  }

  function dispatch(action: Action): void {
    sendMessage({
      kind: "Dispatch",
      action: { _action: sanitizeAction(action) },
    });
  }

  /**
   * Like `dispatch`, but returns a promise that resolves once the worker has
   * applied the action to the local (optimistic) state — i.e. the same
   * snapshot that `subscribeDatabase` delivers.
   *
   * Ordering guarantee: when the promise resolves, the action is present in
   * `getDatabase()` and a `subscribeDatabase` event that includes it has
   * already been delivered. The worker posts the `Database` message before the
   * `Dispatched` ack, and worker→main messages are FIFO. A concurrent server
   * patch may slip a snapshot in between — those snapshots never remove the
   * action, so they don't break the guarantee.
   *
   * The promise rejects if the worker fails to apply the action (or shuts
   * down before applying it).
   *
   * Pass the optional `id` to correlate the dispatch with
   * `subscribeDispatched`: when the commit snapshot is about to be delivered,
   * every `subscribeDispatched` subscriber is called with that same id —
   * synchronously and with `getDatabase()` already pointing at the commit
   * snapshot, but BEFORE the snapshot reaches database subscribers. That lets
   * a main-thread optimistic layer drop its overlay for this action atomically
   * (no re-apply / flicker). Ids must be unique across in-flight dispatches.
   */
  function dispatchAsync(action: Action, id?: number): Promise<void> {
    if (isReady !== null) {
      return Promise.reject(new Error("Cannot dispatch before client.ready()"));
    }
    const dispatchId = id === undefined ? ++dispatchSeq : id;
    return new Promise<void>((resolve, reject) => {
      pendingDispatches.set(dispatchId, { resolve, reject });
      sendMessage({
        kind: "Dispatch",
        id: dispatchId,
        ack: true,
        action: { _action: sanitizeAction(action) },
      });
    });
  }

  function rejectAllPendingDispatches(reason: unknown): void {
    for (const { reject } of pendingDispatches.values()) reject(reason);
    pendingDispatches.clear();
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

  function sendMessage(message: TWorkerInMessage): void {
    emit(message);
  }

  /**
   * Feed a worker→main message into the client (see `WorkerClient.receive`).
   * Anything that is not a sync message — e.g. your own protocol sharing the
   * same worker — is ignored.
   */
  function receive(message: TWorkerOutMessage): void {
    // The host may hand this any `event.data` (even non-objects) when the app
    // shares the worker with its own protocol, so guard loosely at runtime.
    const candidate = message as unknown;
    const kind = (candidate as { kind?: unknown } | null)?.kind;
    if (typeof kind !== "string") {
      return;
    }
    handleOutMessage(message);
  }

  function handleOutMessage(message: TWorkerOutMessage) {
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
        context: restoreContext(message.context._context),
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
      // If this snapshot is the commit of a dispatch, notify its subscribers
      // now — with `state.database` already pointing at the commit snapshot,
      // but BEFORE the snapshot is emitted to database subscribers. A
      // main-thread optimistic layer drops its overlay for the action here, so
      // the `subscribeDatabase` render right after does not re-apply an action
      // the snapshot already contains. (Order matters: dispatched must fire
      // before database — the other way around would render the double-apply
      // before the overlay is dropped.)
      if (message.dispatchedId !== undefined) {
        dispatchedSubscriptions.emit(message.dispatchedId);
      }
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
    if (message.kind === "Dispatched") {
      const pending = pendingDispatches.get(message.id);
      if (!pending) {
        return;
      }
      pendingDispatches.delete(message.id);
      if (message.ok) {
        pending.resolve();
      } else {
        pending.reject(new Error("Dispatch failed to apply"));
      }
      return;
    }
    if (message.kind === "Reload") {
      globalThis.location.reload();
      return;
    }
    if (message.kind === "SessionExpired") {
      rejectAllPendingDispatches(new Error("Session expired before dispatch was applied"));
      forceServerReload();
      return;
    }
    // Unknown kinds are ignored. This keeps the protocol open: an app sharing
    // this worker posts its own `{ kind }` messages through the same channel.
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
