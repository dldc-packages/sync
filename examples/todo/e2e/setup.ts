/**
 * E2E test harness for @dldc/sync example apps.
 *
 * Call `startServer()` inside a test to spin up an isolated server instance
 * (unique port + unique temp data dir) and a headless Chromium. The returned
 * `teardown` closes the browser, kills the server, and cleans the data dir.
 */

import { chromium, type Browser, type Page } from "playwright";

const APP_ROOT = new URL("../", import.meta.url).pathname;

/** Pick a random port in the ephemeral range. */
function randomPort(): number {
  return 4000 + Math.floor(Math.random() * 5000);
}

/** Poll a URL until it responds, or throw after `timeoutMs`. */
async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      res.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/** Wait for a page's sync client to be ready (window.__syncReady === true). */
export function waitForSyncReady(page: Page) {
  return page.waitForFunction(() => (window as any).__syncReady === true, { timeout: 15_000 });
}

export interface TestHandle {
  browser: Browser;
  baseUrl: string;
  teardown: () => Promise<void>;
}

/** Start an isolated server + browser. Returns a handle to use in tests + teardown. */
export async function startServer(): Promise<TestHandle> {
  const PORT = randomPort();
  const DATA_DIR = await Deno.makeTempDir({ prefix: `e2e-todo-${PORT}-` });
  const baseUrl = `http://localhost:${PORT}/`;

  const serverProc = new Deno.Command("deno", {
    args: ["run", "-A", "--unstable-ffi", "--unstable-no-legacy-abort", "./server.ts"],
    cwd: APP_ROOT,
    env: {
      ...Deno.env.toObject(),
      PORT: String(PORT),
      DATA_DIR,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Stream stderr to the console for debugging
  (async () => {
    const reader = serverProc.stderr.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value).trimEnd();
      if (text) console.log(`  [server:${PORT}] ${text}`);
    }
  })();

  await waitForServer(baseUrl);
  console.log(`Server is up on port ${PORT}`);

  const browser = await chromium.launch({ headless: true });

  return {
    browser,
    baseUrl,
    async teardown() {
      await browser.close();
      serverProc.kill("SIGTERM");
      await serverProc.status;
      try {
        await Deno.remove(DATA_DIR, { recursive: true });
      } catch {
        // already gone
      }
    },
  };
}
