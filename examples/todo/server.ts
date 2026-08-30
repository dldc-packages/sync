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
 *
 * In dev, Vite serves the client and proxies /api here. In production (or E2E
 * tests), `dist/` is built first and this server also serves it as static files.
 */
const DIST_DIR = new URL("./dist/", import.meta.url);
const hasStatic = await Deno.stat(DIST_DIR).then(() => true).catch(() => false);

const DATA_DIR = Deno.env.get("DATA_DIR") ?? "./.data";
const PORT = Number(Deno.env.get("PORT") ?? 3000);

const store = await createStore({
  stateDatabasePath: `${DATA_DIR}/state.sqlite`,
  filePath: `${DATA_DIR}/todos.json`,
  getReducer: () => Promise.resolve(reducer),
  restoreAction,
});

console.log(`Todo server listening on http://localhost:${PORT}${hasStatic ? " (serving static)" : ""}`);

Deno.serve({ port: PORT }, handler);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

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

  // Serve static files from dist/ when available (production / E2E mode)
  if (hasStatic) {
    return serveStatic(url.pathname);
  }

  return new Response("Not found", { status: 404 });
}

async function serveStatic(pathname: string): Promise<Response> {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fileUrl = new URL(`.${filePath}`, DIST_DIR);
  try {
    const file = await Deno.open(fileUrl, { read: true });
    const ext = filePath.slice(filePath.lastIndexOf("."));
    return new Response(file.readable, {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
