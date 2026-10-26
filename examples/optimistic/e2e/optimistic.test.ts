/**
 * E2E tests for the optimistic-update example.
 *
 * Only toggling is optimistic in this example: `ToggleTask` runs a deliberately
 * slow reducer, and the main thread flips the checkbox instantly via a cheap
 * patch while the worker is still applying it. Add/Delete are not optimistic —
 * they surface at the slow worker's pace, as expected.
 *
 * These verify:
 *  1. an added task appears once the slow worker commits it, resolves
 *     `dispatchAsync` (the `#applied-count` badge depends only on the promise,
 *     not on how fast the server acks), and reaches `synced`;
 *  2. a burst of adds all apply and all sync;
 *  3. toggling flips the checkbox INSTANTLY (still "pending" — the worker
 *     hasn't committed yet) and never flickers back off, even under the slow
 *     reducer;
 *  4. delete flows through the same lifecycle.
 *
 * Run:  pnpm example:optimistic:e2e  (builds the client first, then this file)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startServer, waitForSyncReady, type TestHandle } from "./setup.ts";

describe("E2E: optimistic updates on the main thread", () => {
  let handle: TestHandle | null = null;

  beforeAll(async () => {
    handle = await startServer();
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  test("a task is added, applied locally, then synced", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const text = `optimistic ${Date.now()}`;
    await page.locator("#task-input").fill(text);
    await page.locator("#task-form button").click();

    // Adds are not optimistic: the row appears once the slow worker commits it.
    await page.locator("#task-list li", { hasText: text }).waitFor({ state: "attached" });

    // `dispatchAsync` resolved → the action is applied locally. This badge
    // depends only on the promise, not on how fast the server acks.
    await page.waitForFunction(
      (expected) => document.querySelector("#applied-count")?.textContent === expected,
      "Applied locally: 1/1",
      { timeout: 10_000 },
    );

    // The server acks it (pending count reaches 0) → synced.
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 15_000 });
    await page.waitForFunction(
      (t) => {
        const li = Array.from(document.querySelectorAll("#task-list li")).find((l) =>
          l.textContent?.includes(t),
        );
        return li?.getAttribute("data-status") === "synced";
      },
      text,
      { timeout: 10_000 },
    );

    await ctx.close();
  });

  test("rapid adds all apply and all sync", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const texts = Array.from({ length: 6 }, (_, i) => `burst ${Date.now()} ${i}`);
    await page.evaluate((taskTexts: string[]) => {
      const input = document.querySelector("#task-input") as HTMLInputElement;
      const form = document.querySelector("#task-form") as HTMLFormElement;
      for (const text of taskTexts) {
        input.value = text;
        form.requestSubmit();
      }
    }, texts);

    // Each add surfaces once the (slow) worker commits it.
    for (const text of texts) {
      await page.locator("#task-list li", { hasText: text }).waitFor({ state: "attached" });
    }

    // All dispatchAsync calls resolve → all applied locally.
    await page.waitForFunction(
      (expected) => document.querySelector("#applied-count")?.textContent === expected,
      `Applied locally: ${texts.length}/${texts.length}`,
      { timeout: 15_000 },
    );
    // Nothing stays pending in the main-thread status bookkeeping.
    await page.waitForFunction(
      () => document.querySelectorAll('#task-list li[data-status="pending"]').length === 0,
      { timeout: 10_000 },
    );

    // And the server eventually acks everything. The server DB already holds
    // tasks from earlier tests, so assert ALL rows are synced — including tasks
    // synced down from the server, which are "synced" by default.
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const lis = Array.from(document.querySelectorAll("#task-list li"));
        return lis.length >= 6 && lis.every((li) => li.getAttribute("data-status") === "synced");
      },
      { timeout: 10_000 },
    );

    await ctx.close();
  });

  test("toggling renders instantly ahead of the slow worker and never flickers", async () => {
    // Add a task and let it settle, so the worker is idle before we toggle.
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const text = `no-flicker ${Date.now()}`;
    await page.locator("#task-input").fill(text);
    await page.locator("#task-form button").click();
    const row = page.locator("#task-list li", { hasText: text });
    await row.waitFor({ state: "attached" });
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 10_000 });
    const taskId = (await row.getAttribute("data-id")) ?? "";
    expect(taskId).toBeTruthy();

    // Toggle. The optimistic render is synchronous with the click (cheap
    // patch), ahead of the worker: the render history must show `done: true`
    // while the entry is still "pending" (the slow toggle hasn't been applied
    // locally yet).
    await row.locator("input[type=checkbox]").check();
    await page.waitForFunction(
      (id) => {
        const history = (window as any).__renderHistory?.[id] ?? [];
        return history.some(
          (e: { done: boolean; status: string }) => e.done && e.status === "pending",
        );
      },
      taskId,
      { timeout: 5_000 },
    );

    // Let the worker commit + the server ack. Any double-apply would render
    // (and record) a `false` here.
    await page.waitForSelector(`#task-list li.done:has-text("${text}")`, { timeout: 10_000 });
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 20_000 });

    // The per-render `done` history must be monotonic: once true, always true.
    const history = await page.evaluate(
      (id) => (window as any).__renderHistory?.[id]?.map((e: { done: boolean }) => e.done) ?? [],
      taskId,
    );
    expect(history.length).toBeGreaterThan(1);
    let sawTrue = false;
    for (const done of history) {
      if (done) sawTrue = true;
      expect(done || !sawTrue, `checkbox flickered back off: ${JSON.stringify(history)}`).toBe(
        true,
      );
    }

    await ctx.close();
  });

  test("delete flows through the lifecycle", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const text = `toggle-delete ${Date.now()}`;
    await page.locator("#task-input").fill(text);
    await page.locator("#task-form button").click();
    const row = page.locator("#task-list li", { hasText: text });
    await row.waitFor({ state: "attached" });
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 10_000 });

    // Delete is not optimistic: the row goes once the slow worker commits it.
    await row.locator("[data-action='delete']").click();
    await row.waitFor({ state: "detached" });
    await page.waitForSelector("#sync-badge[data-synced='true']", { timeout: 20_000 });

    // Both actions (add + delete) were applied locally via dispatchAsync.
    await page.waitForFunction(
      (expected) => document.querySelector("#applied-count")?.textContent === expected,
      "Applied locally: 2/2",
      { timeout: 10_000 },
    );

    await ctx.close();
  });
});
