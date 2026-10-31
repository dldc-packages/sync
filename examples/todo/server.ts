import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createStore } from "../../src/server.ts";
import { derive, reducer, restoreAction } from "./shared.ts";

/**
 * The todo server.
 *
 * `createStore` wires up:
 *  - a state store backed by `stateFilePath` (the JSON todo file) — the data that the
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
const DIST_DIR = fileURLToPath(new URL("./dist/", import.meta.url));
const hasStatic = existsSync(DIST_DIR);

const DATA_DIR = process.env.DATA_DIR ?? "./.data";
const PORT = Number(process.env.PORT ?? 3000);

const store = await createStore({
  metaFilePath: `${DATA_DIR}/state.sqlite`,
  stateFilePath: `${DATA_DIR}/todos.json`,
  derivedFilePath: `${DATA_DIR}/todos.derived`,
  restoreAction,
  getReducer: () => Promise.resolve(reducer),
  getDerive: () => Promise.resolve(derive),
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  readBody(req).then(async (body) => {
    try {
      // Abort the sync stream when the client disconnects (like req.signal on
      // the Web platform).
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const request = new Request(toUrl(req), {
        method: req.method,
        headers: toHeaders(req),
        body: body.length > 0 ? (body as unknown as BodyInit) : undefined,
      });
      const response = await handler(request, controller.signal);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } else {
        res.end();
      }
    } catch (err) {
      console.error("[server] request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(err));
      } else {
        res.destroy();
      }
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Todo server listening on http://localhost:${PORT}${hasStatic ? " (serving static)" : ""}`,
  );
});

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

async function handler(req: Request, signal: AbortSignal): Promise<Response> {
  const url = new URL(req.url);

  const match = url.pathname.match(/^\/api\/client\/([^/]+)\/(sync|dispatch)$/);
  if (match) {
    const clientId = match[1];
    const kind = match[2];
    if (kind === "sync") {
      const body = new Uint8Array(await req.arrayBuffer());
      return store.sync(body, clientId, signal);
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
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const fullPath = `${DIST_DIR}${filePath}`;
  if (!existsSync(fullPath)) {
    return new Response("Not found", { status: 404 });
  }
  const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream;
  return new Response(stream, {
    headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
  });
}

// --- node:http → fetch Request adapters -----------------------------------

function toUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
