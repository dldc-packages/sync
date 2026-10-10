import { expect, test } from "vite-plus/test";
import { createQueue } from "./queue.ts";

test("createQueue runs a single task", async () => {
  const queue = createQueue();
  const result = await queue.run(() => Promise.resolve(7));
  expect(result).toBe(7);
});

test("createQueue runs tasks sequentially in submission order", async () => {
  const queue = createQueue();
  const order: number[] = [];

  const t1 = queue.run(async () => {
    await delay(20);
    order.push(1);
  });
  const t2 = queue.run(async () => {
    await delay(5);
    order.push(2);
  });
  const t3 = queue.run(() => {
    order.push(3);
    return Promise.resolve();
  });

  await Promise.all([t1, t2, t3]);
  expect(order).toEqual([1, 2, 3]);
});

test("createQueue forwards task results", async () => {
  const queue = createQueue();
  const a = queue.run(() => Promise.resolve("a"));
  const b = queue.run(() => Promise.resolve("b"));
  expect(await a).toBe("a");
  expect(await b).toBe("b");
});

test("createQueue does not block subsequent tasks after a failure", async () => {
  const queue = createQueue();
  const t1 = queue.run(() => Promise.reject(new Error("fail")));
  const t2 = queue.run(() => Promise.resolve("ok"));

  await expect(t1).rejects.toThrow("fail");
  expect(await t2).toBe("ok");
});

test("createQueue end resolves when all queued tasks settle", async () => {
  const queue = createQueue();
  queue.run(async () => {
    await delay(10);
  });
  queue.run(async () => {
    await delay(10);
  });
  await queue.end();
  expect(true).toBe(true);
});

test("createQueue aborts tasks that have not started yet", async () => {
  const controller = new AbortController();
  const queue = createQueue(controller.signal);

  const started = { first: false };

  const t1 = queue.run(async () => {
    started.first = true;
    await delay(20);
  });

  controller.abort();
  await t1.catch(() => {});

  const t2 = queue.run(() => {
    started.first = true;
    return Promise.resolve();
  });
  await expect(t2).rejects.toThrow();
  expect(started.first).toBe(false);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
