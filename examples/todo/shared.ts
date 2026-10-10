import type { TRestoreAction, TSanitizeAction, TStoreReducer } from "../../src/shared.ts";

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
 */

export interface Todo {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoState {
  todos: Todo[];
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

/**
 * The reducer: given the current file, a context and an action, produce the
 * next file. This is a pure function — it must be deterministic, because both
 * the server and every client apply the exact same action to reach the same
 * state.
 */
export const reducer: TStoreReducer<Action, Context> = (file, _context, action): Uint8Array => {
  const state = decode(file);
  switch (action.kind) {
    case "AddTodo":
      state.todos.push({ id: action.id, text: action.text, done: false });
      break;
    case "ToggleTodo": {
      const todo = state.todos.find((t) => t.id === action.id);
      if (todo) {
        todo.done = !todo.done;
      }
      break;
    }
    case "DeleteTodo":
      state.todos = state.todos.filter((t) => t.id !== action.id);
      break;
  }
  return encode(state);
};

/**
 * Actions travel between client and server as JSON, so sanitize/restore are
 * identity here (unlike mimo-stats which uses zenjson to encode Temporal /
 * custom types). Types are asserted rather than validated to keep the example
 * short; real apps should validate with a schema (valibot) like mimo-stats does.
 */
export const sanitizeAction: TSanitizeAction<Action> = (action) => action;
export const restoreAction: TRestoreAction<Action> = (data) => data as Action;
