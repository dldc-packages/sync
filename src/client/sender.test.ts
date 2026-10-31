import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api.ts";
import { UnauthorizedError } from "./errors.ts";
import { createSender } from "./sender.ts";
import type { SanitizedOutboxAction } from "./storage.ts";
import type { Store } from "./store.ts";

const outboxAction: SanitizedOutboxAction = {
  ts: "ts-1",
  action: { _action: { kind: "add", id: "a" } },
  sent: false,
};

/** The real `withLock` uses `navigator.locks`; stub it as a pass-through. */
function stubNavigatorLocks(): void {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
    },
  });
}

type GetNextUnsent = Store["getNextUnsent"];
type MarkOutboxAsSent = Store["markOutboxAsSent"];
type DispatchAction = ApiClient["dispatchAction"];
type OnExhausted = (sanitizedOutboxAction: SanitizedOutboxAction) => void;
type OnUnauthorized = () => void;

interface TestDeps {
  getNextUnsent: ReturnType<typeof vi.fn<GetNextUnsent>>;
  markOutboxAsSent: ReturnType<typeof vi.fn<MarkOutboxAsSent>>;
  dispatchAction: ReturnType<typeof vi.fn<DispatchAction>>;
  onExhausted: ReturnType<typeof vi.fn<OnExhausted>>;
  onUnauthorized: ReturnType<typeof vi.fn<OnUnauthorized>>;
  apiClient: ApiClient;
  store: Store;
  signal: AbortSignal;
}

function makeDeps(
  overrides: {
    getNextUnsent?: ReturnType<typeof vi.fn<GetNextUnsent>>;
    dispatchAction?: ReturnType<typeof vi.fn<DispatchAction>>;
  } = {},
): TestDeps {
  const getNextUnsent = overrides.getNextUnsent ?? vi.fn<GetNextUnsent>(async () => null);
  const markOutboxAsSent = vi.fn<MarkOutboxAsSent>(async () => {});
  const dispatchAction = overrides.dispatchAction ?? vi.fn<DispatchAction>(async () => {});
  const ctrl = new AbortController();

  const store: Store = {
    getNextUnsent,
    markOutboxAsSent,
  } as unknown as Store;
  const apiClient: ApiClient = { sync: vi.fn(), dispatchAction } as unknown as ApiClient;

  return {
    getNextUnsent,
    markOutboxAsSent,
    dispatchAction,
    onExhausted: vi.fn<OnExhausted>(),
    onUnauthorized: vi.fn<OnUnauthorized>(),
    apiClient,
    store,
    signal: ctrl.signal,
  };
}

function makeSender(deps: TestDeps): void {
  createSender({
    apiClient: deps.apiClient,
    store: deps.store,
    clientId: "client-1",
    signal: deps.signal,
    onExhausted: deps.onExhausted,
    onUnauthorized: deps.onUnauthorized,
    sendLockName: "send",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createSender", () => {
  it("sends the first unsent outbox action and marks it as sent", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({
      getNextUnsent: vi
        .fn<GetNextUnsent>()
        .mockResolvedValueOnce(outboxAction)
        .mockResolvedValueOnce(null),
    });
    makeSender(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "client-1",
      outboxAction.action,
      outboxAction.ts,
    );
    expect(deps.markOutboxAsSent).toHaveBeenCalledWith("ts-1");
    expect(deps.onExhausted).not.toHaveBeenCalled();
  });

  it("does not send anything when the outbox is empty", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({ getNextUnsent: vi.fn<GetNextUnsent>(async () => null) });
    makeSender(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.dispatchAction).not.toHaveBeenCalled();
    expect(deps.markOutboxAsSent).not.toHaveBeenCalled();
    expect(deps.getNextUnsent).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff on failure, then succeeds", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({
      getNextUnsent: vi
        .fn<GetNextUnsent>()
        .mockResolvedValueOnce(outboxAction)
        .mockResolvedValueOnce(null),
      dispatchAction: vi
        .fn<DispatchAction>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined),
    });
    makeSender(deps);

    // First attempt fails and schedules a backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.dispatchAction).toHaveBeenCalledTimes(1);

    // Backoff elapses, second attempt succeeds.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.dispatchAction).toHaveBeenCalledTimes(2);
    expect(deps.markOutboxAsSent).toHaveBeenCalledWith("ts-1");
    expect(deps.onExhausted).not.toHaveBeenCalled();
  });

  it("reports onExhausted after reaching the max attempts", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({
      getNextUnsent: vi
        .fn<GetNextUnsent>()
        .mockResolvedValueOnce(outboxAction)
        .mockResolvedValueOnce(null),
      dispatchAction: vi.fn<DispatchAction>(async () => {
        throw new Error("always fails");
      }),
    });
    makeSender(deps);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000_000);

    // 10 attempts then exhaustion.
    expect(deps.dispatchAction).toHaveBeenCalledTimes(10);
    expect(deps.onExhausted).toHaveBeenCalledTimes(1);
    expect(deps.onExhausted).toHaveBeenCalledWith(outboxAction);
    expect(deps.markOutboxAsSent).not.toHaveBeenCalled();
  });

  it("calls onUnauthorized and stops on an unauthorized error", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({
      getNextUnsent: vi.fn<GetNextUnsent>(async () => outboxAction),
      dispatchAction: vi.fn<DispatchAction>(async () => {
        throw new UnauthorizedError();
      }),
    });
    makeSender(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(deps.dispatchAction).toHaveBeenCalledTimes(1);
    expect(deps.markOutboxAsSent).not.toHaveBeenCalled();
    expect(deps.onExhausted).not.toHaveBeenCalled();
  });

  it("does not start sending when already aborted", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps();
    deps.signal = AbortSignal.abort();
    makeSender(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.dispatchAction).not.toHaveBeenCalled();
    expect(deps.getNextUnsent).not.toHaveBeenCalled();
  });

  it("wake() restarts the loop after it stopped on an empty outbox", async () => {
    stubNavigatorLocks();
    vi.useFakeTimers();
    const deps = makeDeps({
      getNextUnsent: vi
        .fn<GetNextUnsent>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(outboxAction)
        .mockResolvedValueOnce(null),
    });
    const sender = createSender({
      apiClient: deps.apiClient,
      store: deps.store,
      clientId: "client-1",
      signal: deps.signal,
      onExhausted: deps.onExhausted,
      onUnauthorized: deps.onUnauthorized,
      sendLockName: "send",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.dispatchAction).not.toHaveBeenCalled();

    sender.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.dispatchAction).toHaveBeenCalledWith(
      "client-1",
      outboxAction.action,
      outboxAction.ts,
    );
    expect(deps.markOutboxAsSent).toHaveBeenCalledWith("ts-1");
  });
});
