import { expect, test } from "vite-plus/test";
import { createDeferred } from "./deferred.ts";

test("createDeferred resolves with the provided value", async () => {
  const d = createDeferred<string>();
  d.resolve("hello");
  expect(await d.promise).toBe("hello");
});

test("createDeferred rejects with the provided error", async () => {
  const d = createDeferred<string, Error>();
  d.reject(new Error("boom"));
  await expect(d.promise).rejects.toThrow("boom");
});

test("createDeferred resolve happens before reject", async () => {
  const d = createDeferred<number>();
  d.resolve(1);
  d.reject(new Error("too late"));
  expect(await d.promise).toBe(1);
});

test("createDeferred can be awaited before resolution", async () => {
  const d = createDeferred<number>();
  setTimeout(() => d.resolve(42), 5);
  expect(await d.promise).toBe(42);
});
