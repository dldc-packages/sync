/**
 * E2E stress test for @dldc/sync using the todo example app.
 *
 * Multiple clients add and delete many todos concurrently, then we verify
 * all clients eventually converge to the same state.
 *
 * Run:  pnpm example:todo:e2e  (builds the client first, then runs this file)
 */

import type { Page } from "playwright";
import { afterAll, beforeAll, describe, test } from "vitest";
import { startServer, waitForSyncReady, type TestHandle } from "./setup.ts";

const NUM_CLIENTS = 3;
const TODOS_PER_CLIENT = 10;

// ─── page helpers ───────────────────────────────────────────────────────────

/** Read the todo text list from the page DOM. */
async function getTodoTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#todo-list li label")).map((l) => l.textContent ?? ""),
  );
}

/** Add multiple todos on a page in a single evaluate call (fast, no DOM round-trips). */
async function addTodos(page: Page, texts: string[]): Promise<void> {
  await page.evaluate((todoTexts) => {
    const input = document.querySelector("#todo-input") as HTMLInputElement;
    const form = document.querySelector("#todo-form") as HTMLFormElement;
    for (const text of todoTexts) {
      input.value = text;
      form.requestSubmit();
    }
  }, texts);
}

/** Delete todos whose label text matches any of `texts` on a page. */
async function deleteTodosByText(page: Page, texts: string[]): Promise<void> {
  await page.evaluate((todoTexts) => {
    const lis = document.querySelectorAll("#todo-list li");
    for (const li of Array.from(lis)) {
      const label = li.querySelector("label")?.textContent ?? "";
      if (todoTexts.includes(label)) {
        (li.querySelector("[data-action='delete']") as HTMLElement).click();
      }
    }
  }, texts);
}

/** Poll until every page has exactly `expectedCount` todos and all sets match. */
async function waitForConvergence(
  pages: Page[],
  expectedCount: number,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const allTexts = await Promise.all(pages.map((p) => getTodoTexts(p)));
    const allCorrectCount = allTexts.every((t) => t.length === expectedCount);
    if (allCorrectCount) {
      const sorted = allTexts.map((t) => [...t].sort());
      const first = JSON.stringify(sorted[0]);
      if (sorted.every((s) => JSON.stringify(s) === first)) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Collect final state for the error message
  const finalState = await Promise.all(pages.map((p) => getTodoTexts(p)));
  throw new Error(
    `Convergence timeout: clients did not agree on ${expectedCount} todos within ${timeoutMs}ms\n` +
      finalState.map((t, i) => `  client ${i} (${t.length}): ${JSON.stringify(t)}`).join("\n"),
  );
}

// ─── test ───────────────────────────────────────────────────────────────────

describe("E2E: stress test - concurrent add/delete across multiple clients", () => {
  let handle: TestHandle | null = null;

  beforeAll(async () => {
    handle = await startServer();
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  test("concurrent add: 3 clients x 10 todos", async () => {
    const { browser, baseUrl } = handle!;
    const contexts = [];
    const pages: Page[] = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await waitForSyncReady(page);
      contexts.push(ctx);
      pages.push(page);
    }

    try {
      const start = Date.now();
      // Each client adds its batch of todos simultaneously
      await Promise.all(
        pages.map(async (page, clientIdx) => {
          const texts = Array.from({ length: TODOS_PER_CLIENT }, (_, i) => `c${clientIdx}-t${i}`);
          await addTodos(page, texts);
        }),
      );

      const expected = NUM_CLIENTS * TODOS_PER_CLIENT;
      await waitForConvergence(pages, expected);
      console.log(`  converged to ${expected} todos in ${Date.now() - start}ms`);
    } finally {
      for (const ctx of contexts) {
        await ctx.close();
      }
    }
  });

  test("concurrent delete: each client deletes half its todos", async () => {
    const { browser, baseUrl } = handle!;
    const contexts = [];
    const pages: Page[] = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await waitForSyncReady(page);
      contexts.push(ctx);
      pages.push(page);
    }

    try {
      const start = Date.now();
      const half = Math.floor(TODOS_PER_CLIENT / 2);
      // Each client deletes the first half of its own todos simultaneously
      await Promise.all(
        pages.map(async (page, clientIdx) => {
          const toDelete = Array.from({ length: half }, (_, i) => `c${clientIdx}-t${i}`);
          await deleteTodosByText(page, toDelete);
        }),
      );

      const expected = NUM_CLIENTS * (TODOS_PER_CLIENT - half);
      await waitForConvergence(pages, expected);
      console.log(`  converged to ${expected} todos in ${Date.now() - start}ms`);
    } finally {
      for (const ctx of contexts) {
        await ctx.close();
      }
    }
  });

  test("final state is consistent across all clients", async () => {
    const { browser, baseUrl } = handle!;
    const contexts = [];
    const pages: Page[] = [];
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await waitForSyncReady(page);
      contexts.push(ctx);
      pages.push(page);
    }

    try {
      // Fresh contexts start from an empty local file and sync down async, so
      // wait for convergence before asserting (like the sibling tests).
      const expected = NUM_CLIENTS * (TODOS_PER_CLIENT - Math.floor(TODOS_PER_CLIENT / 2));
      await waitForConvergence(pages, expected);

      const allTexts = await Promise.all(pages.map((p) => getTodoTexts(p)));
      const sorted = allTexts.map((t) => [...t].sort());
      const first = JSON.stringify(sorted[0]);
      if (!sorted.every((s) => JSON.stringify(s) === first)) {
        throw new Error(
          "Clients disagree on final state:\n" +
            sorted.map((s, i) => `  client ${i}: ${JSON.stringify(s)}`).join("\n"),
        );
      }
      console.log(`  all ${NUM_CLIENTS} clients agree on ${sorted[0].length} todos`);
    } finally {
      for (const ctx of contexts) {
        await ctx.close();
      }
    }
  });
});
