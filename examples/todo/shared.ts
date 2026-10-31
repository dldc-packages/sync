import type { TDerive, TRestoreAction, TSanitizeAction, TStoreReducer } from "../../src/shared.ts";

/**
 * The shared types + reducer for the todo example.
 *
 * Unlike mimo-stats (which stores a full SQL database and reduces actions onto
 * it), this example stores plain JSON in a single text file. The reducer is the
 * bridge between that file and the actions:
 *
 *   Uint8Array  ->  string  ->  JSON  ->  apply action  ->  JSON  ->  string  ->  Uint8Array
 *
 * `@dldc/sync` only ever moves opaque `Uint8Array`s around (via rsync), so the
 * file format is completely up to us. Here it's a UTF-8 JSON document.
 *
 * This example also demonstrates the **derived** feature: a second, never-synced
 * value that lives next to the state (a small index: ids + counters). It is
 * recomputed from the state via `derive` (on initial load and on every server
 * patch) and maintained incrementally by the reducer, which receives the
 * current derived as its 4th argument and returns `{ state, derived }`. The
 * main thread shows it (the summary line) via `subscribeDerived`.
 */

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoState {
  todos: Todo[];
}

/** The derived index: an id → { text, done } map plus counters. */
export interface TodoDerived {
  total: number;
  done: number;
  open: number;
  byId: Record<string, { text: string; done: boolean }>;
}

export type Action =
  | { kind: "AddTodo"; id: string; text: string }
  | { kind: "ToggleTodo"; id: string }
  | { kind: "DeleteTodo"; id: string };

// This example has no per-user context. An empty object keeps the signature
// compatible with `TStoreReducer<Action, Context>`.
export type Context = Record<never, never>;

/**
 * Decode a raw file (Uint8Array) into a `TodoState`.
 *
 * A freshly created file is empty (zero bytes), so an empty buffer means an
 * empty todo list rather than a JSON parse error.
 */
function decode(file: Uint8Array): TodoState {
  if (file.byteLength === 0) {
    return { todos: [] };
  }
  const text = new TextDecoder().decode(file);
  return JSON.parse(text) as TodoState;
}

/** Encode a `TodoState` back into a raw file. */
function encode(state: TodoState): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(state));
}

function decodeDerived(bytes: Uint8Array): TodoDerived {
  if (bytes.byteLength === 0) {
    return { total: 0, done: 0, open: 0, byId: {} };
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as TodoDerived;
}

function encodeDerived(derived: TodoDerived): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(derived));
}

/**
 * Recompute the derived index from the state file. `prevDerived` is a hint (we
 * ignore it and rebuild — simplest and always correct); there is no prev here.
 * Must produce the same index the reducer maintains, so client/server agree.
 */
export const derive: TDerive = (file, _prevDerived): Uint8Array => {
  const state = decode(file);
  const byId: Record<string, { text: string; done: boolean }> = {};
  let done = 0;
  for (const todo of state.todos) {
    byId[todo.id] = { text: todo.text, done: todo.done };
    if (todo.done) done += 1;
  }
  const derived: TodoDerived = {
    total: state.todos.length,
    done,
    open: state.todos.length - done,
    byId,
  };
  return encodeDerived(derived);
};

/**
 * The reducer: given the current file, a context and an action, produce the
 * next file (and the next derived index). This is a pure function — it must be
 * deterministic, because both the server and every client apply the exact same
 * action to reach the same state.
 *
 * The 4th argument (`currentDerived`) is the derived index for the current
 * file; the reducer builds on it and returns `{ state, derived }`. The server
 * uses both; the derived also lets the reducer compute the next state when the
 * index feeds back into the computation (see the server-side test).
 */
export const reducer: TStoreReducer<Action, Context> = (
  file,
  _context,
  action,
  currentDerived,
): { state: Uint8Array; derived: Uint8Array } => {
  const state = decode(file);
  const derived = decodeDerived(currentDerived);
  switch (action.kind) {
    case "AddTodo":
      state.todos.push({ id: action.id, text: action.text, done: false });
      derived.byId[action.id] = { text: action.text, done: false };
      derived.total += 1;
      derived.open += 1;
      break;
    case "ToggleTodo": {
      const todo = state.todos.find((t) => t.id === action.id);
      if (todo) {
        todo.done = !todo.done;
        const entry = derived.byId[action.id];
        if (entry) {
          entry.done = todo.done;
        } else {
          derived.byId[action.id] = { text: todo.text, done: todo.done };
        }
        if (todo.done) {
          derived.done += 1;
          derived.open -= 1;
        } else {
          derived.done -= 1;
          derived.open += 1;
        }
      }
      break;
    }
    case "DeleteTodo": {
      const todo = state.todos.find((t) => t.id === action.id);
      state.todos = state.todos.filter((t) => t.id !== action.id);
      if (todo) {
        delete derived.byId[action.id];
        derived.total -= 1;
        if (todo.done) {
          derived.done -= 1;
        } else {
          derived.open -= 1;
        }
      }
      break;
    }
  }
  return { state: encode(state), derived: encodeDerived(derived) };
};

/**
 * Actions travel between client and server as JSON, so sanitize/restore are
 * identity here (unlike mimo-stats which uses zenjson to encode Temporal /
 * custom types). Types are asserted rather than validated to keep the example
 * short; real apps should validate with a schema (valibot) like mimo-stats does.
 */
export const sanitizeAction: TSanitizeAction<Action> = (action) => action;
export const restoreAction: TRestoreAction<Action> = (data) => data as Action;
