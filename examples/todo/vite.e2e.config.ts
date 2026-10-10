import { defineConfig } from "vitest/config";

// Standalone Vitest config for the example's browser E2E suite (Playwright).
// These tests boot a real Node server + headless Chromium, so they run apart
// from the fast unit suite and with much longer timeouts.
export default defineConfig({
  test: {
    include: ["examples/todo/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
