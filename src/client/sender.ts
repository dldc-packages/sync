import type { ApiClient } from "./api.ts";
import { UnauthorizedError } from "./errors.ts";
import { withLock } from "./lock.ts";
import type { OpfsClient, SanitizedPendingAction } from "./opfs.ts";

export interface Sender {
  /** Wake up the send loop (e.g. after a dispatch added to pending). */
  wake(): void;
}

export interface SenderParams {
  apiClient: ApiClient;
  opfsClient: OpfsClient;
  clientId: string;
  signal: AbortSignal;
  onExhausted: (sanitizedPending: SanitizedPendingAction) => void;
  onUnauthorized?: () => void;
  sendLockName: string;
}

const BACKOFF_BASE_DELAY = 1000;
const BACKOFF_MAX_DELAY = 30_000;
const BACKOFF_MAX_ATTEMPTS = 10;

/**
 * A self-sufficient loop that sends pending actions to the server one by one
 * under the send lock. Runs independently from the sync loop.
 *
 * Each iteration:
 * - Acquire send lock
 * - Read state from OPFS, find first unsent pending action
 * - If none, stop (the loop will be restarted by `wake()`)
 * - Send it via HTTP with retry + exponential backoff (inside the lock)
 * - On success: mark as sent in OPFS, continue to next
 * - On exhaustion (max attempts): skip this action, log, continue to next
 *
 * The `sent` boolean lives on the PendingAction in OPFS, so it's shared across
 * tabs — no double-sending. It persists across restarts: if an action was sent
 * (HTTP 200) but not yet acked by sync, the sender won't re-send it on restart.
 * The server's `updateClientLastApplied` dedups in case of re-send anyway.
 */
export function createSender(
  {
    apiClient,
    clientId,
    onExhausted,
    onUnauthorized,
    opfsClient,
    signal,
    sendLockName,
  }: SenderParams,
): Sender {
  let loopRunning = false;

  // Start immediately (sends any pending from a previous session).
  wake();

  return { wake };

  function wake(): void {
    if (loopRunning || signal.aborted) return;
    loopRunning = true;
    sendLoop();
  }

  async function sendLoop(): Promise<void> {
    while (!signal.aborted) {
      const result = await withLock(
        sendLockName,
        () => sendWithRetry(clientId, signal, onExhausted),
      );
      if (!result.shouldContinue) break;
    }
    loopRunning = false;
  }

  /**
   * Send a single unsent pending action with retry + exponential backoff.
   * Must be called inside the send lock. Returns "sent" or "none" (no unsent
   * pending). Retries up to BACKOFF_MAX_ATTEMPTS times on failure, then logs and
   * returns "sent" to let the loop move on to the next action.
   */
  async function sendWithRetry(
    clientId: string,
    signal: AbortSignal,
    onExhausted: (sanitizedPending: SanitizedPendingAction) => void,
  ): Promise<{ shouldContinue: boolean }> {
    const sanitizedPending = await opfsClient.getNextUnsentPending();
    if (sanitizedPending === null) return { shouldContinue: false };

    for (let attempt = 0; attempt < BACKOFF_MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) return { shouldContinue: false };
      try {
        await apiClient.dispatchAction(
          clientId,
          sanitizedPending.action,
          sanitizedPending.ts,
        );
        await opfsClient.markPendingAsSent(sanitizedPending.ts);
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
    console.error("Send exhausted retries, skipping:", sanitizedPending.ts);
    onExhausted(sanitizedPending);
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
