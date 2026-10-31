import { createWorkerEngine } from "../../../src/client.ts";
import { derive, reducer, restoreAction } from "../shared.ts";
import type { Action, Context } from "../shared.ts";

declare const self: DedicatedWorkerGlobalScope;

/**
 * The worker engine runs in a Web Worker and owns:
 *  - the local copy of the JSON todo file (persisted in OPFS)
 *  - the derived index, persisted in its own OPFS file (`derivedFileName`)
 *  - the same reducer, applied locally for instant optimistic updates
 *  - the sync loop (rsync) + the send loop (HTTP dispatch) to the server
 *
 * The main thread only talks to it via postMessage (through `createWorkerClient`).
 */
const workerEngine = createWorkerEngine<Action, Context>({
  emit: (message, transfer) => self.postMessage(message, transfer),
  close: () => self.close(),
  getReducer: () => Promise.resolve(reducer),
  getDerive: () => Promise.resolve(derive),
  // No auth in this example, so the context is always the empty object.
  getContext: () => Promise.resolve({}),
  syncPath: (clientId) => `/api/client/${clientId}/sync`,
  dispatchPath: (clientId) => `/api/client/${clientId}/dispatch`,
  restoreAction,
  restoreContext: (data) => data as Context,
  sanitizeContext: (context) => context,
  // OPFS + broadcast/lock names must be unique per app to avoid collisions.
  stateFileName: "todo-state.json",
  metaFileName: "todo-meta.json",
  derivedFileName: "todo-derived.json",
  sendLockName: "todo-dispatch",
  opfsLockName: "todo-opfs",
  crossTabDispatchChannelName: "todo-dispatch-notify",
  maxStoredErrors: 20,
  getContextTimeoutMs: 3_000,
});

// Wire the engine to the worker global's message event. The engine owns no
// listener itself, so your own protocol can share this worker (see README).
self.addEventListener("message", (event) => workerEngine.receive(event.data));
workerEngine.start();
