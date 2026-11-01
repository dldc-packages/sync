import { describe, expect, it } from "vitest";
import { createWorkerEngine } from "./workerEngine.ts";

/**
 * The engine runs in a Web Worker and needs OPFS / Web Locks / BroadcastChannel
 * (see `checkCapabilities`). Node has none of the storage APIs, so `start()`
 * always fails during init here — which is exactly the path we want to test:
 * the engine must tell the main thread that it will never be ready.
 */
describe("createWorkerEngine startup failure", () => {
  it("emits InitFailed when startup throws", async () => {
    const messages: unknown[] = [];
    const engine = createWorkerEngine({
      emit: (message) => {
        messages.push(message);
      },
      close: () => {},
      crossTabDispatchChannelName: "test-dispatch",
      stateFileName: "test-state",
      dispatchPath: () => "",
      getContext: () => Promise.resolve({}),
      getContextTimeoutMs: 1_000,
      getReducer: async () => () => new Uint8Array(0),
      getDerive: async () => () => new Uint8Array(0),
      maxStoredErrors: 20,
      metaFileName: "test-meta",
      opfsLockName: "test-opfs",
      restoreAction: (action) => action as never,
      sanitizeContext: (context) => context,
      restoreContext: (context) => context as never,
      sendLockName: "test-send",
      syncPath: () => "",
      derivedFileName: "test-derived",
    });

    engine.start();
    // startup failure is reported asynchronously (promise rejection → .catch).
    await new Promise((resolve) => setTimeout(resolve, 0));

    const initFailed = messages.find((m) => (m as { kind?: string }).kind === "InitFailed") as
      | { kind: "InitFailed"; error: string }
      | undefined;
    expect(initFailed).toBeDefined();
    expect(initFailed!.error).toMatch(/cannot run in this environment/);
  });
});
