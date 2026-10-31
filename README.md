# @dldc/sync

A sync engine for web apps based on **rsync + reducer**.

`@dldc/sync` keeps a single piece of data — a file — synchronized in real time
between a server and any number of clients (browser tabs/devices). The file is
just an opaque `Uint8Array` from the library's point of view: you decide what's
inside it (JSON, a SQL database, msgpack, …).

## How it works

The engine is built on two ideas:

### 1. A pure reducer

You provide a **reducer** — a pure function that takes the current file, a
context, and an action, and returns the next file:

```ts
type TStoreReducer<Action, Context> = (
  file: Uint8Array,
  context: Context,
  action: Action,
) => Uint8Array;
```

The server is the source of truth: every client action is applied through the
reducer to produce the next version of the file. Each client keeps its own copy
and applies the **same reducer locally** so the UI updates instantly, then
reconciles with the server.

The reducer may also be **derived-aware**: it receives the current *derived*
value (see [Derived data](#derived-data-local-index--cache))
as a 4th argument and returns `{ state, derived }` instead of `Uint8Array`. Plain
reducers are unchanged.

### 2. Rsync over a live connection

The server and each client exchange patches computed by
[rsync](https://en.wikipedia.org/wiki/Rsync)-style delta encoding (via
`@dldc/librsync`), so only the changed bytes travel over the wire. A long-lived
HTTP connection (`/sync`) streams patches to the client as they happen — that's
what makes it "real time".

## API surface

| Module              | Purpose                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `@dldc/sync/shared` | Types + helpers shared by client & server (`TStoreReducer`, sanitize/restore, HLC) |
| `@dldc/sync/server` | `createStore` — the authoritative store with reducer + rsync + dispatch            |
| `@dldc/sync/client` | `createWorkerEngine` (worker) + `createWorkerClient` (main thread)                 |

## Getting started

The quickest way to see it working is the runnable
[todo example](./examples/todo/), which stores its data as JSON:

```sh
# Terminal 1 — the Node server (rsync + dispatch, port 3000)
pnpm example:todo

# Terminal 2 — the Vite dev server (port 5173), proxying /api -> :3000
pnpm example:todo:client
# open http://localhost:5173 (open in two tabs to see live sync)
```

To see the client's `dispatchAsync` + `subscribeDispatched` in action —
optimistic updates driven from the main thread *ahead of a slow worker*, with
per-action `applied`/`synced` status and a timing feed — try the
[optimistic example](./examples/optimistic/):

```sh
pnpm example:optimistic           # Node API server (port 3100)
pnpm example:optimistic:client    # Vite dev server (port 5174)
# open http://localhost:5174
```

Requires Node.js `^22.18.0 || ^24.11.0 || >=26.0.0`.

### Server

```ts
import { createStore } from "@dldc/sync/server";
import { derive, reducer, restoreAction } from "./shared.ts";

const store = await createStore({
  metaFilePath: "./state.sqlite", // lib bookkeeping (last-applied, versions)
  stateFilePath: "./data.json", // YOUR app data file — read/written by the reducer
  derivedFilePath: "./data.derived", // derived index/cache
  restoreAction,
  getReducer: async () => reducer,
  getDerive: async () => derive,
});

// POST /api/client/:clientId/sync     -> long-lived rsync stream
// POST /api/client/:clientId/dispatch -> apply an action
```

`createStore` gives you `sync()` and `dispatch()` which you wire up to your HTTP
framework. The `stateFilePath` is your actual data (e.g. JSON); `metaFilePath`
is a SQLite database (via `better-sqlite3`) used internally to track per-client
last-applied timestamps and file versions across restarts.

### Reducer + types (shared)

```ts
import type {
  TDerive,
  TRestoreAction,
  TSanitizeAction,
  TStoreReducer,
} from "@dldc/sync/shared";

interface TodoState {
  todos: { id: string; text: string; done: boolean }[];
}
type Action =
  | { kind: "AddTodo"; id: string; text: string }
  | { kind: "ToggleTodo"; id: string };

const reducer: TStoreReducer<Action, Context> = (file, _ctx, action) => {
  const state = file.byteLength === 0
    ? { todos: [] }
    : JSON.parse(new TextDecoder().decode(file));
  // ...apply action...
  return new TextEncoder().encode(JSON.stringify(state));
};

// Derived is always on (see the Derived section below). A plain reducer
// is fine — `derive` recomputes the index whenever the server content changes.
const derive: TDerive = (file) => {
  const state = file.byteLength === 0
    ? { todos: [] }
    : JSON.parse(new TextDecoder().decode(file));
  return new TextEncoder().encode(JSON.stringify({ count: state.todos.length }));
};

const restoreAction: TRestoreAction<Action> = (data) => data as Action;
const sanitizeAction: TSanitizeAction<Action> = (action) => action;
```

Actions travel between client and server as JSON;
`sanitizeAction`/`restoreAction` convert them (identity for plain data, or
encode/decode custom types).

### Client (browser)

The client engine lives in a **Web Worker** (it owns the local copy in OPFS, the
local reducer, and the sync/send loops). The main thread talks to it via a thin
wrapper:

```ts
// worker.ts
import { createWorkerEngine } from "@dldc/sync/client";
const engine = createWorkerEngine<Action, Context>({
  // wire the transport yourself: forward `transfer` — the engine hands you the
  // state buffers of `Ready`/`State` messages so they're transferred, not cloned.
  emit: (message, transfer) => self.postMessage(message, transfer),
  close: () => self.close(),
  getReducer: async () => reducer,
  getDerive: async () => derive,
  getContext: async () => ({}),
  syncPath: (id) => `/api/client/${id}/sync`,
  dispatchPath: (id) => `/api/client/${id}/dispatch`,
  restoreAction,
  sanitizeContext,
  restoreContext,
  stateFileName: "data.json",
  metaFileName: "meta.json",
  derivedFileName: "data.derived",
  opfsLockName: "app-opfs",
  sendLockName: "app-dispatch",
  crossTabDispatchChannelName: "app-dispatch-notify",
  maxStoredErrors: 20,
  getContextTimeoutMs: 3000,
});
// The engine owns no `message` listener — the app wires it, so its own
// protocol can share the same worker (see below).
self.addEventListener("message", (event) => engine.receive(event.data));
engine.start();
```

```ts
// main.ts
import { createWorkerClient } from "@dldc/sync/client";
const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});
const client = createWorkerClient<Action, Context>({
  // wire the transport yourself
  emit: (message) => worker.postMessage(message),
  sanitizeAction,
  restoreContext,
});
worker.addEventListener("message", (event) => client.receive(event.data));

client.subscribeState((bytes) => render(decode(bytes))); // re-render on changes
client.dispatch({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" }); // optimistic

// Awaitable variant: resolves once the action is applied to the local
// (optimistic) state — the same snapshot subscribeState delivers. When it
// resolves, getState() already contains the action and a subscribeState
// event carrying it was already delivered (see dispatchAsync in the client).
await client.dispatchAsync({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" });

// Main-thread optimistic layers: pass an id to dispatchAsync and subscribe to
// it. subscribeDispatched(id) fires synchronously BEFORE the snapshot that
// commits that action reaches subscribeState, so you can drop your overlay
// for it atomically — and never re-apply an action the snapshot already
// contains (no flicker, even with a slow reducer). See the optimistic example.
client.subscribeDispatched((id) => dropOverlay(id));
await client.dispatchAsync({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" }, 1);
```

#### Run your own protocol on the same worker

The client and engine never own the `message` listener — you wire `receive` and
`emit` yourself, and anything that is not a sync message is ignored. So the same
worker (and the same `message` event) can carry your own `{ kind }` protocol
next to sync: add your own listener and post your own messages. Use a
namespaced `kind` (e.g. `"myapp:count"`) so the two sides never collide.

```ts
// worker.ts — handle your own kind, respond over the same channel
self.addEventListener("message", (event) => {
  if (event.data?.kind !== "myapp:count") return;
  self.postMessage({ kind: "myapp:count-result", value: compute() });
});

// main.ts — send and receive your own kind, alongside the sync client
worker.postMessage({ kind: "myapp:count" });
worker.addEventListener("message", (event) => {
  if (event.data?.kind === "myapp:count-result") render(event.data.value);
});
```

## Derived data (local index / cache)

Beyond the synced file every app maintains a **derived** value — a second value,
never synced, stored next to the state (its own OPFS file on the client, a file
next to the state on the server) and fully re-derivable from the state. Typical
use: an index or aggregate you don't want to rebuild from scratch on every
change.

```ts
// shared.ts — a derived-aware reducer + a derive function
const reducer: TStoreReducer<Action, Context> = (file, ctx, action, currentDerived) => {
  const state = decode(file);
  const index = decodeDerived(currentDerived);
  // ...apply action to BOTH state and index...
  return { state: encode(state), derived: encodeDerived(index) };
};
const derive: TDerive = (state, prevDerived) => { /* recompute the index from state */ };

// client/worker.ts
createWorkerEngine({
  ...,
  getDerive: () => Promise.resolve(derive),
  derivedFileName: "data.derived", // OPFS file next to the state file
});

// server.ts
createStore({
  ...,
  getDerive: () => Promise.resolve(derive),
  derivedFilePath: "./data.derived", // file next to the state file
});
```

On the main thread the derived rides along with every state snapshot:

```ts
client.subscribeDerived((bytes) => renderIndex(decodeDerived(bytes)));
client.getDerived(); // latest derived — always a Uint8Array, never null
```

To force a full rebuild on demand — after a `derive` schema/format change, or when the
persisted derived has drifted and no content change will self-heal it — ask the worker
to re-run `derive` with an empty previous value (ignoring the current one):

```ts
client.forceRecomputeDerived(); // derive() re-runs from scratch, then a fresh
                                // state + derived snapshot is delivered
```

`derive` normally receives the saved derived as a diff hint (`prevDerived`); forcing
passes an empty hint so an incremental `derive` must recompute entirely from the state
(like `client.forceRefresh()`, only it touches the derived alone — nothing is deleted
and no reload happens). The rebuilt value is persisted next to the state, then the new
live derived (with the outbox replayed on top) is delivered through the normal
`subscribeState` / `subscribeDerived` path.

By default the engine includes `derived` in every `Ready`/`State` message. The
cost is one `slice()` copy per emission (~30 µs/MB — the `postMessage` transfer
itself is O(1), zero-copy). For apps that only read the derived at startup (or
keep a very large one), set `emitDerived: false` on the engine: the worker still
computes and persists it, `onDerived` still fires in-process, and the main
thread still receives the *initial* derived via `Ready` — but later snapshots
arrive without a fresh one (`subscribeDerived` doesn't fire for them, and
`getDerived()` keeps the last value, never null).

**Semantics.**

- `derive(state, prevDerived)` recomputes (or incrementally updates) the derived
  for the *committed* server file. It runs on initial load and whenever the
  server content changes. `prevDerived` is a hint so an index can diff instead
  of rebuild — the result must match what the reducer chain produced.
- The reducer maintains derived for optimistic (outbox) actions while they are
  replayed on top of the server content, so the derived the main thread sees
  always matches the state it sees. A reducer that only updates state returns
  the raw file (derived unchanged); one that also maintains derived returns
  `{ state, derived }`.
- Storage follows the same rule as the state: the OPFS/server file holds the
  derived for the committed server content, written only when the version
  changes; outbox actions are re-applied in memory on startup — exactly how
  `localContent` is rebuilt. A stale derived file is harmless: it is recomputed
  from the state on every load.

**Contract.** Both the client **and** the server must configure
`getDerive` + `derivedFileName` / `derivedFilePath`, and `derive` must produce
the same derived value as the reducer chain — otherwise the two sides could
compute different states, since the reducer may use `currentDerived` to compute
the next file.

## Features

- **Real-time sync** via rsync delta patches over a live stream
- **Optimistic UI** — clients apply the reducer locally before the server
  round-trip
- **Offline-first** — outbox actions persist in OPFS and flush when back online
- **Multi-tab** — a broadcast channel keeps tabs in sync
- **Idempotent dispatch** — actions are deduped by hybrid logical clock (HLC)
  timestamp

## License

MIT
