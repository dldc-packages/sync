/**
 * E2E tests for @dldc/sync using the todo example app.
 *
 * Run:  pnpm example:todo:e2e  (builds the client first, then runs this file)
 */

import { afterAll, beforeAll, describe, test } from "vitest";
import { startServer, waitForSyncReady, type TestHandle } from "./setup.ts";

describe("E2E: todo app", () => {
  let handle: TestHandle | null = null;

  beforeAll(async () => {
    handle = await startServer();
  });

  afterAll(async () => {
    await handle?.teardown();
  });

  test("cross-tab sync via BroadcastChannel (same browser context)", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page1 = await ctx.newPage();
    const page2 = await ctx.newPage();

    await page1.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page2.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await waitForSyncReady(page1);
    await waitForSyncReady(page2);

    const todoText = `cross-tab ${Date.now()}`;
    await page1.locator("#todo-input").fill(todoText);
    await page1.locator("#todo-form button").click();

    await page1.waitForSelector("#todo-list li");
    await page1.waitForTimeout(1000);

    const items1 = await page1.locator("#todo-list li").allInnerTexts();
    const items2 = await page2.locator("#todo-list li").allInnerTexts();

    if (!items1.some((t) => t.includes(todoText))) {
      throw new Error(`page1 missing todo "${todoText}". Got: ${JSON.stringify(items1)}`);
    }
    if (!items2.some((t) => t.includes(todoText))) {
      throw new Error(
        `page2 missing todo "${todoText}" (cross-tab sync failed). Got: ${JSON.stringify(items2)}`,
      );
    }

    await ctx.close();
  });

  test("cross-device sync via server (different browser contexts)", async () => {
    const { browser, baseUrl } = handle!;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page2.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await waitForSyncReady(page1);
    await waitForSyncReady(page2);

    const todoText = `cross-device ${Date.now()}`;
    await page1.locator("#todo-input").fill(todoText);
    await page1.locator("#todo-form button").click();

    await page1.waitForSelector("#todo-list li");
    await page2.waitForFunction(
      (text) => document.querySelector("#todo-list")?.textContent?.includes(text),
      todoText,
      { timeout: 10_000 },
    );

    const items2 = await page2.locator("#todo-list li").allInnerTexts();
    if (!items2.some((t) => t.includes(todoText))) {
      throw new Error(
        `page2 missing todo "${todoText}" (cross-device sync failed). Got: ${JSON.stringify(
          items2,
        )}`,
      );
    }

    await ctx1.close();
    await ctx2.close();
  });

  test("toggle and delete sync across devices", async () => {
    const { browser, baseUrl } = handle!;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page2.goto(baseUrl, { waitUntil: "domcontentloaded" });

    await waitForSyncReady(page1);
    await waitForSyncReady(page2);

    const todoText = `toggle-delete ${Date.now()}`;
    await page1.locator("#todo-input").fill(todoText);
    await page1.locator("#todo-form button").click();

    await page2.waitForFunction(
      (text) => document.querySelector("#todo-list")?.textContent?.includes(text),
      todoText,
      { timeout: 10_000 },
    );

    const todoLi2 = page2.locator("#todo-list li", { hasText: todoText });
    await todoLi2.locator("input[type=checkbox]").click();

    await page1.locator("#todo-list li.done", { hasText: todoText }).waitFor({
      timeout: 10_000,
    });

    const todoLi1 = page1.locator("#todo-list li", { hasText: todoText });
    await todoLi1.locator("[data-action='delete']").click();

    await page2.waitForFunction(
      (text) => !document.querySelector("#todo-list")?.textContent?.includes(text),
      todoText,
      { timeout: 10_000 },
    );

    await ctx1.close();
    await ctx2.close();
  });

  test("dispatchAsync resolves only once the action is in the local state", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const todoId = `async-${Date.now()}`;
    const result = await page.evaluate(async (id: string) => {
      const client = (window as any).__client as {
        ready: () => Promise<void>;
        subscribeDatabase: (cb: (bytes: Uint8Array) => void) => () => void;
        getDatabase: () => Uint8Array;
        dispatchAsync: (action: unknown) => Promise<void>;
      };
      await client.ready();

      const decode = (bytes: Uint8Array): { todos: { id: string }[] } => {
        if (bytes.byteLength === 0) return { todos: [] };
        return JSON.parse(new TextDecoder().decode(bytes));
      };

      let eventsWithAction = 0;
      const unsub = client.subscribeDatabase((bytes) => {
        const state = decode(bytes);
        if (state.todos.some((t) => t.id === id)) eventsWithAction += 1;
      });

      // Ordering guarantee: the worker posts the "Database" message with the
      // action BEFORE the "Dispatched" ack that resolves this promise, and
      // worker->main messages are FIFO. So by the time the await resumes, the
      // action must already be in getDatabase() and in a delivered event.
      await client.dispatchAsync({ kind: "AddTodo", id, text: `async ${id}` });

      const inDbAtResolve = decode(client.getDatabase()).todos.some((t) => t.id === id);
      unsub();
      return { eventsWithAction, inDbAtResolve };
    }, todoId);

    if (!result.inDbAtResolve) {
      throw new Error(
        `dispatchAsync resolved but the action was not in getDatabase() yet (${JSON.stringify(
          result,
        )})`,
      );
    }
    if (result.eventsWithAction < 1) {
      throw new Error(
        `dispatchAsync resolved but no subscribeDatabase event included the action (${JSON.stringify(
          result,
        )})`,
      );
    }

    await ctx.close();
  });

  test("concurrent dispatchAsync calls all apply and resolve (per-id ack correlation)", async () => {
    const { browser, baseUrl } = handle!;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForSyncReady(page);

    const id1 = `conc1-${Date.now()}`;
    const id2 = `conc2-${Date.now()}`;

    const result = await page.evaluate(
      async ({ a, b }: { a: string; b: string }) => {
        const client = (window as any).__client as {
          ready: () => Promise<void>;
          getDatabase: () => Uint8Array;
          dispatchAsync: (action: unknown) => Promise<void>;
        };
        await client.ready();

        const decode = (bytes: Uint8Array): { todos: { id: string }[] } => {
          if (bytes.byteLength === 0) return { todos: [] };
          return JSON.parse(new TextDecoder().decode(bytes));
        };

        // Fire both without awaiting: acks must be matched per-id, not globally.
        await Promise.all([
          client.dispatchAsync({ kind: "AddTodo", id: a, text: `a ${a}` }),
          client.dispatchAsync({ kind: "AddTodo", id: b, text: `b ${b}` }),
        ]);

        const ids = decode(client.getDatabase()).todos.map((t) => t.id);
        return { hasA: ids.includes(a), hasB: ids.includes(b), dbOrder: ids };
      },
      { a: id1, b: id2 },
    );

    if (!result.hasA || !result.hasB) {
      throw new Error(
        `both concurrent dispatchAsync actions must be applied (${JSON.stringify(result)})`,
      );
    }

    await ctx.close();
  });
});
