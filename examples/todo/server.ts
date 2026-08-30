import { createStore } from "../../src/server.ts";
import { reducer, restoreAction } from "./shared.ts";

/**
 * The todo server.
 *
 * `createStore` wires up:
 *  - a file store backed by `filePath` (the JSON todo file) — the data that the
 *    reducer reads/writes, and the source of truth synced to clients via rsync
 *  - a state database (SQLite, internal to the lib) that tracks per-client
 *    last-applied timestamps + the file version across restarts
 *
 * This example uses JSON for the *data* file; the internal state DB is always
 * SQLite (that's the lib's own bookkeeping, not the app data).
 */
const store = await createStore({
  stateDatabasePath: "./.data/state.sqlite",
  filePath: "./.data/todos.json",
  getReducer: () => Promise.resolve(reducer),
  restoreAction,
});

const PORT = Number(Deno.env.get("PORT") ?? 3000);
console.log(`Todo server listening on http://localhost:${PORT}`);

Deno.serve({ port: PORT }, handler);

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const match = url.pathname.match(/^\/api\/client\/([^/]+)\/(sync|dispatch)$/);
  if (match) {
    const clientId = match[1];
    const kind = match[2];
    if (kind === "sync") {
      const body = new Uint8Array(await req.arrayBuffer());
      return store.sync(body, clientId, req.signal);
    }
    // dispatch
    const body = await req.json();
    // Empty context: this example has no auth/users.
    return store.dispatch(body, clientId, {});
  }

  return new Response("Not found", { status: 404 });
}
