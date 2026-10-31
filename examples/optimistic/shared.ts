import type { TRestoreAction, TSanitizeAction, TDerive, TStoreReducer } from "../../src/shared.ts";

/**
 * Shared types + reducer for the optimistic example.
 *
 * The data file is a plain JSON document (`{ "tasks": [...] }`), exactly like
 * the todo example. `@dldc/sync` only ever moves opaque `Uint8Array`s around
 * (via rsync), so the file format is entirely up to us:
 *
 *   Uint8Array  ->  string  ->  JSON  ->  apply action  ->  JSON  ->  string  ->  Uint8Array
 *
 * The interesting part of this example is NOT the reducer (it's identical in
 * spirit to the todo example) — it's `client/main.ts`, which mirrors the
 * toggle optimistically on the MAIN thread with a cheap patch and uses
 * `dispatchAsync` + `subscribeDispatched` to reconcile to the authoritative
 * snapshot exactly when the (deliberately slow) worker engine commits an
 * action. Note: only the worker and the server run this reducer — the main
 * thread never does (it would freeze the UI).
 */

export interface Task {
  id: string;
  text: string;
  done: boolean;
}

export interface TaskState {
  tasks: Task[];
}

export type Action =
  | { kind: "AddTask"; id: string; text: string }
  | { kind: "ToggleTask"; id: string }
  | { kind: "DeleteTask"; id: string };

// No per-user context in this example — empty object keeps the signature
// compatible with `TStoreReducer<Action, Context>`.
export type Context = Record<never, never>;

/** Decode a raw file (Uint8Array) into a `TaskState`. An empty file means no tasks. */
function decode(file: Uint8Array): TaskState {
  if (file.byteLength === 0) {
    return { tasks: [] };
  }
  const text = new TextDecoder().decode(file);
  return JSON.parse(text) as TaskState;
}

/** Encode a `TaskState` back into a raw file. */
function encode(state: TaskState): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state));
}

/** Encode an arbitrary serializable value back into a raw file. */
function encodeJson<T>(value: T): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * The reducer: a pure, deterministic function. Both the server and every
 * client's worker apply the exact same action to reach the same state.
 *
 * It deliberately burns time (the busy loop below) to SIMULATE a slow reducer —
 * that is what makes "optimistic main thread vs worker" worth having for
 * toggles: the worker has to apply + rebase + round-trip to commit the flip,
 * while the main thread shows it instantly via a cheap patch. The main thread
 * itself never runs this reducer.
 */
export const reducer: TStoreReducer<Action, Context> = (file, _context, action): Uint8Array => {
  const state = decode(file);
  // Slow reducer: busy-wait to simulate expensive work (~50ms per call).
  for (let i = 0; i < 500_000; i++) {
    crypto.randomUUID();
  }
  switch (action.kind) {
    case "AddTask":
      state.tasks.push({ id: action.id, text: action.text, done: false });
      break;
    case "ToggleTask": {
      const task = state.tasks.find((t) => t.id === action.id);
      if (task) {
        task.done = !task.done;
      }
      break;
    }
    case "DeleteTask":
      state.tasks = state.tasks.filter((t) => t.id !== action.id);
      break;
  }
  return encode(state);
};

/** Actions travel between client and server as JSON, so sanitize/restore are identity. */
export const sanitizeAction: TSanitizeAction<Action> = (action) => action;
export const restoreAction: TRestoreAction<Action> = (data) => data as Action;

// ─── derived ─────────────────────────────────────────────────────────────────
//
// Derived is always on: every app maintains a second, local value computed from
// the state. Here it's a tiny task-count index — the optimistic example's real
// point is the main-thread patch layer in `./main.ts`, so this stays minimal
// and just keeps the example honest (client and server run the same `derive`).

export interface TaskDerived {
  total: number;
  done: number;
}

/** Recompute the task-count index from the state file (ignores the previous hint). */
export const derive: TDerive = (file) => {
  const state = decode(file);
  return encodeJson<TaskDerived>({
    total: state.tasks.length,
    done: state.tasks.filter((t) => t.done).length,
  });
};
