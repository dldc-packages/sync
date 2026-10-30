import { createWorkerEngine } from "../../../src/client.ts";
import { reducer, restoreAction } from "../shared.ts";
import type { Action, Context } from "../shared.ts";

declare const self: DedicatedWorkerGlobalScope;

/**
 * The worker engine runs in a Web Worker and owns:
 *  - the local copy of the JSON tasks file (persisted in OPFS)
 *  - the same reducer, applied locally for instant updates
 *  - the sync loop (rsync) + the send loop (HTTP dispatch) to the server
 *
 * The main thread talks to it via postMessage (through `createWorkerClient`).
 * This file is identical to the todo example's — the optimistic logic lives on
 * the main thread in `./main.ts`.
 */
const workerEngine = createWorkerEngine<Action, Context>({
  emit: (message, transfer) => self.postMessage(message, transfer),
  close: () => self.close(),
  getReducer: () => Promise.resolve(reducer),
  // No auth in this example, so the context is always the empty object.
  getContext: () => Promise.resolve({}),
  syncPath: (clientId) => `/api/client/${clientId}/sync`,
  dispatchPath: (clientId) => `/api/client/${clientId}/dispatch`,
  restoreAction,
  restoreContext: (data) => data as Context,
  sanitizeContext: (context) => context,
  // OPFS + broadcast/lock names must be unique per app to avoid collisions.
  dbFileName: "optimistic-tasks.json",
  stateFileName: "optimistic-state.json",
  sendLockName: "optimistic-dispatch",
  opfsLockName: "optimistic-opfs",
  crossTabDispatchChannelName: "optimistic-dispatch-notify",
  maxStoredErrors: 20,
  getContextTimeoutMs: 3_000,
});

// Wire the engine to the worker global's message event. The engine owns no
// listener itself, so your own protocol can share this worker (see README).
self.addEventListener("message", (event) => workerEngine.receive(event.data));
workerEngine.start();
