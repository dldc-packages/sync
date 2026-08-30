import { createWorkerEngine } from "../../../src/client.ts";
import { reducer, restoreAction } from "../shared.ts";
import type { Action, Context } from "../shared.ts";

declare const self: DedicatedWorkerGlobalScope;

/**
 * The worker engine runs in a Web Worker and owns:
 *  - the local copy of the JSON todo file (persisted in OPFS)
 *  - the same reducer, applied locally for instant optimistic updates
 *  - the sync loop (rsync) + the send loop (HTTP dispatch) to the server
 *
 * The main thread only talks to it via postMessage (through `createWorkerClient`).
 */
const workerEngine = createWorkerEngine<Action, Context>({
  getReducer: () => Promise.resolve(reducer),
  // No auth in this example, so the context is always the empty object.
  getContext: () => Promise.resolve({}),
  syncPath: (clientId) => `/api/client/${clientId}/sync`,
  dispatchPath: (clientId) => `/api/client/${clientId}/dispatch`,
  restoreAction,
  restoreContext: (data) => data as Context,
  sanitizeContext: (context) => context,
  // OPFS + broadcast/lock names must be unique per app to avoid collisions.
  dbFileName: "todo-database.json",
  stateFileName: "todo-state.json",
  sendLockName: "todo-dispatch",
  opfsLockName: "todo-opfs",
  crossTabDispatchChannelName: "todo-dispatch-notify",
  maxStoredErrors: 20,
  getContextTimeoutMs: 3_000,
});

self.onmessage = workerEngine.handleMessage;
workerEngine.start();
