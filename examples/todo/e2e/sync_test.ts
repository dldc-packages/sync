/**
 * E2E tests for @dldc/sync using the todo example app.
 *
 * Run:  deno task test:e2e  (builds the client first, then runs this file)
 */

import { startServer, waitForSyncReady } from "./setup.ts";

Deno.test("E2E: todo app", async (t) => {
  const { browser, baseUrl, teardown } = await startServer();
  try {
    await t.step(
      "cross-tab sync via BroadcastChannel (same browser context)",
      async () => {
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
          throw new Error(
            `page1 missing todo "${todoText}". Got: ${JSON.stringify(items1)}`,
          );
        }
        if (!items2.some((t) => t.includes(todoText))) {
          throw new Error(
            `page2 missing todo "${todoText}" (cross-tab sync failed). Got: ${
              JSON.stringify(items2)
            }`,
          );
        }

        await ctx.close();
      },
    );

    await t.step(
      "cross-device sync via server (different browser contexts)",
      async () => {
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
          (text) =>
            document.querySelector("#todo-list")?.textContent?.includes(text),
          todoText,
          { timeout: 10_000 },
        );

        const items2 = await page2.locator("#todo-list li").allInnerTexts();
        if (!items2.some((t) => t.includes(todoText))) {
          throw new Error(
            `page2 missing todo "${todoText}" (cross-device sync failed). Got: ${
              JSON.stringify(items2)
            }`,
          );
        }

        await ctx1.close();
        await ctx2.close();
      },
    );

    await t.step("toggle and delete sync across devices", async () => {
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
        (text) =>
          document.querySelector("#todo-list")?.textContent?.includes(text),
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
        (text) =>
          !document.querySelector("#todo-list")?.textContent?.includes(text),
        todoText,
        { timeout: 10_000 },
      );

      await ctx1.close();
      await ctx2.close();
    });
  } finally {
    await teardown();
  }
});
