import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const root = import.meta.dirname;

export default defineConfig({
  // Self-references resolve to src, so the library build and tests exercise the
  // public subpaths against source (the same trick ts-api uses).
  resolve: {
    alias: {
      "@dldc/sync": resolve(root, "src"),
    },
  },

  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.types.ts"],
    },
  },

  fmt: {
    // Generated snapshots are owned by Vitest's snapshot writer; prose docs and
    // CI files are kept untouched by the formatter to avoid unrelated churn.
    ignorePatterns: [
      "**/__snapshots__/**",
      "**/*.md",
      ".github/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
    ],
  },

  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // `any` was the only excluded rule in the previous Deno lint config.
      "no-explicit-any": "off",
    },
  },

  // Library build (tsdown). The entry map mirrors the export map in
  // package.json so every public subpath has its own emitted module + types.
  pack: {
    entry: {
      client: "src/client.ts",
      "client/internal": "src/client/internal.ts",
      server: "src/server.ts",
      "server/internal": "src/server/internal.ts",
      shared: "src/shared.ts",
      "shared/internal": "src/shared/internal.ts",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
  },
});
