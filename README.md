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
import { reducer, restoreAction } from "./shared.ts";

const store = await createStore({
  stateDatabasePath: "./state.sqlite", // lib bookkeeping (last-applied, versions)
  filePath: "./data.json", // YOUR app data file — read/written by the reducer
  getReducer: async () => reducer,
  restoreAction,
});

// POST /api/client/:clientId/sync     -> long-lived rsync stream
// POST /api/client/:clientId/dispatch -> apply an action
```

`createStore` gives you `sync()` and `dispatch()` which you wire up to your HTTP
framework. The `filePath` is your actual data (e.g. JSON); `stateDatabasePath`
is a SQLite database (via `better-sqlite3`) used internally to track per-client
last-applied timestamps and file versions across restarts.

### Reducer + types (shared)

```ts
import type {
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
  getReducer: async () => reducer,
  getContext: async () => ({}),
  syncPath: (id) => `/api/client/${id}/sync`,
  dispatchPath: (id) => `/api/client/${id}/dispatch`,
  restoreAction,
  sanitizeContext,
  restoreContext,
  dbFileName: "data.json",
  stateFileName: "state.json",
  opfsLockName: "app-opfs",
  sendLockName: "app-dispatch",
  crossTabDispatchChannelName: "app-dispatch-notify",
  maxStoredErrors: 20,
  getContextTimeoutMs: 3000,
});
self.onmessage = engine.handleMessage;
engine.start();
```

```ts
// main.ts
import { createWorkerClient } from "@dldc/sync/client";
const client = createWorkerClient<Action, Context>({
  worker: new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  }),
  sanitizeAction,
  restoreContext,
});

client.subscribeDatabase((bytes) => render(decode(bytes))); // re-render on changes
client.dispatch({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" }); // optimistic

// Awaitable variant: resolves once the action is applied to the local
// (optimistic) state — the same snapshot subscribeDatabase delivers. When it
// resolves, getDatabase() already contains the action and a subscribeDatabase
// event carrying it was already delivered (see dispatchAsync in the client).
await client.dispatchAsync({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" });

// Main-thread optimistic layers: pass an id to dispatchAsync and subscribe to
// it. subscribeDispatched(id) fires synchronously BEFORE the snapshot that
// commits that action reaches subscribeDatabase, so you can drop your overlay
// for it atomically — and never re-apply an action the snapshot already
// contains (no flicker, even with a slow reducer). See the optimistic example.
client.subscribeDispatched((id) => dropOverlay(id));
await client.dispatchAsync({ kind: "AddTodo", id: crypto.randomUUID(), text: "hi" }, 1);
```

### Client layering: core + transport

Both ends are split into a **core** (the sync logic, no `postMessage`) and a
**transport** (the DOM wiring), and the public API is their composition:

```ts
createWorkerEngine  = (p) => createWorkerEngineTransport(createWorkerEngineCore(p))
createWorkerClient  = (p) => createWorkerClientTransport(createWorkerClientCore(p), p.worker)
```

A core is a `TMessageBus`: `emit(msg)` feeds messages into the logic (decoded
from the wire), `onMessage(handler)` exposes the messages it produces (to be
posted). The transport connects that bus to the worker boundary and returns the
engine/client plus two extras:

- `send(msg, transfer?)` — post any message to the other side (the `Ready`/
  `Database` database buffers are transferred automatically via
  `getMessageTransferables`);
- `router` — a `createMessageRouter()` that dispatches each incoming message by
  its exact `kind`.

Because the transport routes on `kind` strings, an app can extend it with its
own message protocols instead of adding extra `message` listeners — one
`onmessage` per side routes everything:

```ts
// worker.ts — own an `idx:` protocol on the same transport as sync
const engine = createWorkerEngine(params);
engine.router.on("idx:query", (m) => indexer.handle(m));
engine.router.on("idx:reindex", (m) => indexer.reindex());
engine.start();
```

The `handleMessage` returned by `createWorkerEngine` keeps the
`self.onmessage = engine.handleMessage` pattern working; the `Terminate`
message is transport-owned (the core aborts its loops, the host closes). Cores
and transports are exported separately (`@dldc/sync/client`) for apps that want
to re-implement the wire layer themselves.

## Features


- **Real-time sync** via rsync delta patches over a live stream
- **Optimistic UI** — clients apply the reducer locally before the server
  round-trip
- **Offline-first** — pending actions persist in OPFS and flush when back online
- **Multi-tab** — a broadcast channel keeps tabs in sync
- **Idempotent dispatch** — actions are deduped by hybrid logical clock (HLC)
  timestamp

## License

MIT
