import type { ApiClient } from "./api.ts";
import { UnauthorizedError } from "./errors.ts";
import { withLock } from "./lock.ts";
import type { SanitizedOutboxAction } from "./storage.ts";
import type { Store } from "./store.ts";

export interface Sender {
  /** Wake up the send loop (e.g. after a dispatch added to the outbox). */
  wake(): void;
}

export interface SenderParams {
  apiClient: ApiClient;
  store: Store;
  clientId: string;
  signal: AbortSignal;
  onExhausted: (sanitizedOutboxAction: SanitizedOutboxAction) => void;
  onUnauthorized?: () => void;
  sendLockName: string;
}

const BACKOFF_BASE_DELAY = 1000;
const BACKOFF_MAX_DELAY = 30_000;
const BACKOFF_MAX_ATTEMPTS = 10;

/**
 * A self-sufficient loop that sends outbox actions to the server one by one
 * under the send lock. Runs independently from the sync loop.
 *
 * Each iteration:
 * - Acquire send lock
 * - Ask the store for the first unsent outbox action (from OPFS, under the
 *   OPFS lock which the store owns)
 * - If none, stop (the loop will be restarted by `wake()`)
 * - Send it via HTTP with retry + exponential backoff (inside the lock)
 * - On success: mark as sent in OPFS (via the store), continue to next
 * - On exhaustion (max attempts): skip this action, log, continue to next
 *
 * The `sent` boolean lives on the outbox action in OPFS, so it's shared across
 * tabs — no double-sending. It persists across restarts: if an action was sent
 * (HTTP 200) but not yet acked by sync, the sender won't re-send it on restart.
 * The server's `updateClientLastApplied` dedups in case of re-send anyway.
 */
export function createSender({
  apiClient,
  clientId,
  onExhausted,
  onUnauthorized,
  store,
  signal,
  sendLockName,
}: SenderParams): Sender {
  let loopRunning = false;

  // Start immediately (sends any outbox action from a previous session).
  wake();

  return { wake };

  function wake(): void {
    if (loopRunning || signal.aborted) return;
    loopRunning = true;
    sendLoop();
  }

  async function sendLoop(): Promise<void> {
    while (!signal.aborted) {
      const result = await withLock(sendLockName, () =>
        sendWithRetry(clientId, signal, onExhausted),
      );
      if (!result.shouldContinue) break;
    }
    loopRunning = false;
  }

  /**
   * Send a single unsent outbox action with retry + exponential backoff.
   * Must be called inside the send lock. Returns "sent" or "none" (no unsent
   * outbox action). Retries up to BACKOFF_MAX_ATTEMPTS times on failure, then
   * logs and returns "sent" to let the loop move on to the next action.
   */
  async function sendWithRetry(
    clientId: string,
    signal: AbortSignal,
    onExhausted: (sanitizedOutboxAction: SanitizedOutboxAction) => void,
  ): Promise<{ shouldContinue: boolean }> {
    const sanitized = await store.getNextUnsent();
    if (sanitized === null) return { shouldContinue: false };

    for (let attempt = 0; attempt < BACKOFF_MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) return { shouldContinue: false };
      try {
        await apiClient.dispatchAction(clientId, sanitized.action, sanitized.ts);
        await store.markOutboxAsSent(sanitized.ts);
        return { shouldContinue: true };
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized?.();
          return { shouldContinue: false };
        }
        console.error(`Send failed (attempt ${attempt + 1}):`, err);
        if (attempt < BACKOFF_MAX_ATTEMPTS - 1) {
          await sleep(computeBackoff(attempt), signal);
        }
      }
    }
    console.error("Send exhausted retries, skipping:", sanitized.ts);
    onExhausted(sanitized);
    return { shouldContinue: true };
  }

  function computeBackoff(attempt: number): number {
    const exp = BACKOFF_BASE_DELAY * 2 ** attempt;
    const capped = Math.min(exp, BACKOFF_MAX_DELAY);
    return Math.floor(capped / 2 + Math.random() * (capped / 2));
  }

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
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
