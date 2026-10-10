import { signature } from "@dldc/librsync";
import { fileSyncTransportReader, type TFileSyncMessage } from "../shared/fileSync.ts";
import { assertOk, UnauthorizedError } from "./errors.ts";
import type { SanitizedAction } from "./opfs.ts";

export interface ApiClient {
  /**
   * Like EventSource but over POST with a binary body.
   *
   * Keeps the /api/client/:clientId/sync connection alive by reconnecting with
   * exponential backoff + jitter whenever the stream ends or errors. On each
   * reconnect a fresh signature is computed from `getContent()` so the server
   * can diff against the latest client state. Aborting `signal` stops
   * reconnection.
   */
  sync(
    signal: AbortSignal,
    clientId: string,
    getContent: () => Uint8Array,
  ): AsyncIterable<TFileSyncMessage>;

  dispatchAction(clientId: string, action: SanitizedAction, ts: string): Promise<void>;
}

export interface ApiClientParams {
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  syncPath: (clientId: string) => string;
  dispatchPath: (clientId: string) => string;
  onUnauthorized: () => void;
}

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30_000;

export function createApiClient({
  reconnectBaseDelay = RECONNECT_BASE_DELAY,
  reconnectMaxDelay = RECONNECT_MAX_DELAY,
  syncPath,
  dispatchPath,
  onUnauthorized,
}: ApiClientParams): ApiClient {
  return {
    sync,
    dispatchAction,
  };

  function sync(
    signal: AbortSignal,
    clientId: string,
    getContent: () => Uint8Array,
  ): AsyncIterable<TFileSyncMessage> {
    return {
      [Symbol.asyncIterator]: async function* () {
        let attempt = 0;
        while (!signal.aborted) {
          try {
            const res = await fetch(syncPath(clientId), {
              signal,
              method: "POST",
              body: signature(getContent(), 512).buffer,
            });
            assertOk(res);
            if (!res.body) {
              throw new Error("Response body is null");
            }
            const reader = res.body.getReader();
            try {
              for await (const message of fileSyncTransportReader(reader)) {
                attempt = 0;
                yield message;
              }
            } finally {
              try {
                reader.releaseLock();
              } catch {
                // reader may already be released or locked by a pending read
              }
            }
          } catch (err) {
            if (signal.aborted) {
              return;
            }
            if (err instanceof UnauthorizedError) {
              onUnauthorized?.();
              return;
            }
            console.error("[sync] connection error:", err);
          }
          if (signal.aborted) {
            return;
          }
          await sleep(computeBackoff(attempt), signal);
          if (signal.aborted) {
            return;
          }
          attempt += 1;
        }
      },
    };
  }

  async function dispatchAction(
    clientId: string,
    action: SanitizedAction,
    ts: string,
  ): Promise<void> {
    const res = await fetch(dispatchPath(clientId), {
      method: "POST",
      body: JSON.stringify({ action: action._action, ts }),
      credentials: "include",
    });
    assertOk(res);
  }

  function computeBackoff(attempt: number): number {
    const exp = reconnectBaseDelay * 2 ** attempt;
    const capped = Math.min(exp, reconnectMaxDelay);
    return Math.floor(capped / 2 + Math.random() * (capped / 2));
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
