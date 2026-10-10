import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// The browser client is served by Vite; the Node server (server.ts) handles the
// /api routes. Vite proxies /api to the long-running Node server.
//
// This is a plain config object (no `vite` import): the CLI runs from the
// package root, where `vite` itself is provided by the Vite+ toolchain rather
// than a hoisted package, and a bare import would fail to resolve from here.
export default {
  root,
  build: {
    outDir: `${root}/dist`,
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
};
