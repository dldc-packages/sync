import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFileSyncMessage } from "../shared/fileSync.ts";
import { streamTransportWriteAll } from "../shared/stream.ts";
import { createApiClient } from "./api.ts";
import { UnauthorizedError } from "./errors.ts";
import type { SanitizedAction } from "./storage.ts";

/** Encode messages into the wire format the sync stream consumes. */
function encodeMessages(...messages: TFileSyncMessage[]): Uint8Array {
  return streamTransportWriteAll<TFileSyncMessage>(messages);
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** A minimal Response whose body yields the given chunks then completes. */
function stubResponse(bodyChunks: Uint8Array[], ok = true, status = 200): Response {
  let i = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          if (i < bodyChunks.length) return { done: false, value: bodyChunks[i++] };
          return { done: true, value: new Uint8Array(0) };
        },
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
}

const syncPath = (id: string) => `/sync/${id}`;
const dispatchPath = (id: string) => `/dispatch/${id}`;

const toSanitized = (action: unknown): SanitizedAction => ({ _action: action });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createApiClient.dispatchAction", () => {
  it("POSTs the sanitized action and ts to the dispatch path", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();

    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized });
    await api.dispatchAction("client-1", toSanitized({ kind: "add", id: "a" }), "ts-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/dispatch/client-1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      action: { kind: "add", id: "a" },
      ts: "ts-1",
    });
  });

  it("forwards configured headers and credentials", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const api = createApiClient({
      syncPath,
      dispatchPath,
      onUnauthorized: () => {},
      headers: { Authorization: "Bearer abc" },
      credentials: "include",
    });
    await api.dispatchAction("client-1", toSanitized({}), "ts-1");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({ Authorization: "Bearer abc" });
    expect(init?.credentials).toBe("include");
  });

  it("throws an UnauthorizedError on a 401 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchLike>(async () => stubResponse([], false, 401)),
    );
    const onUnauthorized = vi.fn();
    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized });

    await expect(api.dispatchAction("client-1", toSanitized({}), "ts-1")).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // dispatchAction itself does not trigger onUnauthorized — only the sync loop does.
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("throws a generic error on other non-ok statuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<FetchLike>(async () => stubResponse([], false, 500)),
    );
    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized: () => {} });

    await expect(api.dispatchAction("client-1", toSanitized({}), "ts-1")).rejects.toThrow(/500/);
  });
});

describe("createApiClient.sync", () => {
  it("yields decoded messages from the sync stream", async () => {
    const messages: TFileSyncMessage[] = [
      { name: "Connected", data: null },
      {
        name: "InitialPatch",
        data: { patch: new Uint8Array([1, 2, 3]), version: "v1", clientLastApplied: null },
      },
    ];
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([encodeMessages(...messages)]));
    vi.stubGlobal("fetch", fetchMock);

    const onUnauthorized = vi.fn();
    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized });
    const iterator = api
      .sync(new AbortController().signal, "client-1", () => new Uint8Array(0))
      [Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: messages[0] });
    expect(await iterator.next()).toEqual({ done: false, value: messages[1] });
  });

  it("POSTs a signature of the current content to the sync path", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized: () => {} });
    const ctrl = new AbortController();

    const pending = api
      .sync(ctrl.signal, "client-1", () => new Uint8Array([9, 8, 7]))
      [Symbol.asyncIterator]()
      .next();
    await vi.advanceTimersByTimeAsync(0); // let the first fetch resolve

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/sync/client-1");
    expect(init?.method).toBe("POST");
    // Body is the librsync signature of the current content.
    const body = init?.body as ArrayBuffer | undefined;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(body!.byteLength).toBeGreaterThan(0);

    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("stops and notifies onUnauthorized when the server responds 401", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([], false, 401));
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const api = createApiClient({ syncPath, dispatchPath, onUnauthorized });

    const iterator = api
      .sync(new AbortController().signal, "client-1", () => new Uint8Array(0))
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops reconnecting once aborted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(async () => stubResponse([])); // stream ends immediately
    vi.stubGlobal("fetch", fetchMock);
    const onUnauthorized = vi.fn();
    const api = createApiClient({
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 200,
      syncPath,
      dispatchPath,
      onUnauthorized,
    });
    const ctrl = new AbortController();

    const pending = api
      .sync(ctrl.signal, "client-1", () => new Uint8Array(0))
      [Symbol.asyncIterator]()
      .next();
    // First attempt connects, stream ends, backoff timer starts.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reconnect fires after the backoff delay (may reconnect more than once).
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    ctrl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual({ done: true, value: undefined });
  });
});
