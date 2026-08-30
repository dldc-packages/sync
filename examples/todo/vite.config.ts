import deno from "@deno/vite-plugin";
import { defineConfig } from "vite";

// The browser client is served by Vite; the Deno server (server.ts) handles the
// /api routes. Vite proxies /api to the long-running Deno server.
export default defineConfig({
  plugins: [deno()],
  worker: {
    plugins: () => [deno()],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
