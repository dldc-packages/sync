/**
 * E2E test harness for @dldc/sync example apps.
 *
 * Call `startServer()` inside a test to spin up an isolated server instance
 * (unique port + unique temp data dir) and a headless Chromium. The returned
 * `teardown` closes the browser, kills the server, and cleans the data dir.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));

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
      void res.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/** Wait for a page's sync client to be ready (window.__syncReady === true). */
export function waitForSyncReady(page: Page) {
  return page.waitForFunction(() => (window as any).__syncReady === true, {
    timeout: 15_000,
  });
}

export interface TestHandle {
  browser: Browser;
  baseUrl: string;
  teardown: () => Promise<void>;
}

/** Start an isolated server + browser. Returns a handle to use in tests + teardown. */
export async function startServer(): Promise<TestHandle> {
  const PORT = randomPort();
  const DATA_DIR = await mkdtemp(join(tmpdir(), `e2e-optimistic-${PORT}-`));
  const baseUrl = `http://localhost:${PORT}/`;

  const serverProc = spawn("node", ["--import", "tsx", "server.ts"], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  // Stream stderr to the console for debugging
  const decoder = new TextDecoder();
  serverProc.stderr.on("data", (chunk) => {
    const text = decoder.decode(chunk).trimEnd();
    if (text) console.log(`  [server:${PORT}] ${text}`);
  });

  await waitForServer(baseUrl);
  console.log(`Server is up on port ${PORT}`);

  const browser = await chromium.launch({ headless: true });

  return {
    browser,
    baseUrl,
    async teardown() {
      await browser.close();
      serverProc.kill("SIGTERM");
      await waitForExit(serverProc);
      await rm(DATA_DIR, { recursive: true, force: true });
    },
  };
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once("exit", () => resolve());
  });
}
