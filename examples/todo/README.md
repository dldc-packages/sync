# Todo — a `@dldc/sync` example (JSON storage)

A minimal full-stack todo app demonstrating `@dldc/sync`, modeled on
[mimo-stats](https://github.com/etienne-dldc/mimo-stats) but storing the app
data as **plain JSON** instead of a SQL database.

The point of this example is the **reducer**: it shows how the data file is just
an opaque `Uint8Array` from `@dldc/sync`'s point of view, and that _you_ decide
what's inside it. Here the reducer converts the file to a string, parses JSON,
applies the action, and encodes it back:

```
Uint8Array  ->  string  ->  JSON  ->  apply action  ->  JSON  ->  string  ->  Uint8Array
```

See [`shared.ts`](./shared.ts) for the reducer and types.

## Layout

```
todo/
├── shared.ts          # types + the JSON reducer + sanitize/restore (shared client/server)
├── server.ts          # Node server: createStore + /api/client/:id/{sync,dispatch}
├── index.html         # browser entry
├── vite.config.ts     # dev server; proxies /api to the Node server
└── client/
    ├── main.ts        # UI, talks to the worker via createWorkerClient
    ├── worker.ts      # createWorkerEngine: local copy, reducer, sync + send loops
    └── style.css
```

- **`server.ts`** calls `createStore` with `filePath` (the JSON todo file) and
  `stateDatabasePath` (SQLite via `better-sqlite3` — internal bookkeeping only,
  not the app data).
- **`client/worker.ts`** runs the engine in a Web Worker: it keeps a local copy
  of the JSON file in OPFS, applies the same reducer locally for instant
  updates, and syncs with the server via rsync.
- **`client/main.ts`** decodes the synced bytes back into JSON and renders them.

## Run it

Two processes (like mimo-stats): a Node API server and a Vite dev server.
Everything resolves from the **repo root** via pnpm — run the scripts there:

```sh
# Terminal 1 — the Node API server (port 3000)
pnpm example:todo

# Terminal 2 — the Vite dev server (port 5173), proxying /api -> :3000
pnpm example:todo:client
```

- Vite: http://localhost:5173 (open this in a browser)
- Node API server: http://localhost:3000

Open the page in two tabs/windows to watch changes sync live.

> `@dldc/sync`'s internal state DB is SQLite via `@dldc/zendb-better-sqlite3`
> (better-sqlite3's native binding is compiled on install). Only the _app data_
> is JSON.

## End-to-end tests

The E2E suite builds the client, boots a real Node server + headless Chromium,
and runs Playwright against it (cross-tab, cross-device, and a multi-client
convergence stress test):

```sh
pnpm example:todo:e2e   # vite build && vitest run (Playwright)
```

## How the reducer stores data

The todo file (`todo/.data/todos.json`) looks like:

```json
{ "todos": [{ "id": "1", "text": "Buy milk", "done": true }] }
```

Every `AddTodo` / `ToggleTodo` / `DeleteTodo` action is applied by the reducer
to produce the next version of this file. The server applies it as the source of
truth; each client applies the same action locally so the UI updates instantly,
then reconciles via rsync.

## Testing the server manually

```sh
pnpm example:todo        # from the repo root — boots the Node server
```

```sh
curl -X POST localhost:3000/api/client/c1/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"action":{"kind":"AddTodo","id":"1","text":"hi"},"ts":"1700000000000-00000001"}'
```
