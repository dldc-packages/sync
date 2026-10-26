import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// The browser client is served by Vite; the Node server (server.ts) handles the
// /api routes. Vite proxies /api to the long-running Node server.
export default {
  root,
  build: {
    outDir: `${root}/dist`,
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3100",
    },
  },
};
