import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerClient } from "./workerClient.ts";

type TestAction = { type: "noop" };
type TestContext = { userId: string };

function createClient() {
  const emit = vi.fn();
  const client = createWorkerClient<TestAction, TestContext>({
    emit,
    sanitizeAction: (action) => action,
    restoreContext: (data) => data as TestContext,
  });
  return { client, emit };
}

const readyMessage = {
  kind: "Ready",
  context: { _context: { userId: "u1" } },
  state: new Uint8Array([1, 2, 3]).buffer,
  derived: new Uint8Array(0).buffer,
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWorkerClient.ready", () => {
  it("rejects when the worker reports InitFailed", async () => {
    const { client } = createClient();
    const readyPromise = client.ready();
    client.receive({ kind: "InitFailed", error: "No context available" });
    await expect(readyPromise).rejects.toThrow("Worker failed to initialize: No context available");
    // ready() must keep rejecting, never resolve.
    await expect(client.ready()).rejects.toThrow("Worker failed to initialize");
  });

  it("rejects when SessionExpired arrives before Ready", async () => {
    vi.stubGlobal("location", { pathname: "/", replace: vi.fn() });
    const { client } = createClient();
    const readyPromise = client.ready();
    client.receive({ kind: "SessionExpired" });
    await expect(readyPromise).rejects.toThrow("Session expired before the worker became ready");
    await expect(client.ready()).rejects.toThrow("Session expired");
  });

  it("rejects after stop()", async () => {
    const { client } = createClient();
    const readyPromise = client.ready();
    client.stop();
    await expect(readyPromise).rejects.toThrow("Worker stopped");
    await expect(client.ready()).rejects.toThrow("Worker stopped");
  });

  it("still rejects if a failure races a Ready message", async () => {
    const { client } = createClient();
    const readyPromise = client.ready();
    client.receive({ kind: "InitFailed", error: "boom" });
    client.receive(readyMessage);
    await expect(readyPromise).rejects.toThrow("Worker failed to initialize");
  });
});

describe("createWorkerClient messages", () => {
  it("resolves ready() and delivers state on Ready", async () => {
    const { client } = createClient();
    const readyPromise = client.ready();
    client.receive(readyMessage);
    await expect(readyPromise).resolves.toBeUndefined();
    expect(client.getState()).toEqual(new Uint8Array([1, 2, 3]));
    expect(client.getContext()).toEqual({ userId: "u1" });
  });
});
