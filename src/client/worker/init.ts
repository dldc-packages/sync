import { UnauthorizedError } from "./errors.ts";
import {
  createOpfsClient,
  type OpfsClient,
  type PendingAction,
  type StoredError,
} from "./opfs.ts";
import type {
  TGetContext,
  TRestoreContext,
  TSanitizeContext,
} from "./types.ts";

/** Values computed once during `start()` and never reassigned. */
interface EngineInit<Action, Context> {
  context: Context;
  clientId: string;
  pending: PendingAction<Action>[];
  serverVersion: string | null;
  errors: StoredError[];
  database: Uint8Array;
  opfsClient: OpfsClient<Action, Context>;
}

export interface InitParams<Context> {
  onNoContextError: () => void;
  onUnauthorized: () => void;
  getContext: TGetContext<Context>;
  restoreContext: TRestoreContext<Context>;
  sanitizeContext: TSanitizeContext<Context>;
  dbFileName: string;
  stateFileName: string;
  maxStoredErrors: number;
  opfsLockName: string;
  getContextTimeoutMs: number;
}

export async function init<Action, Context>(
  {
    onNoContextError,
    onUnauthorized,
    getContext,
    restoreContext,
    sanitizeContext,
    dbFileName,
    stateFileName,
    maxStoredErrors,
    opfsLockName,
    getContextTimeoutMs,
  }: InitParams<
    Context
  >,
): Promise<EngineInit<Action, Context> | null> {
  const opfsClient = createOpfsClient<Action, Context>({
    dbFileName,
    stateFileName,
    maxStoredErrors,
    opfsLockName,
    restoreContext,
    sanitizeContext,
  });

  // Load persisted state + DB from OPFS (under the lock) — load BEFORE getMe
  // so we can fall back to the saved context if the network is unavailable.
  const {
    database,
    context: initContext,
    clientId,
    pending,
    errors,
    serverVersion,
  } = await opfsClient
    .loadInitial();
  const savedContext = initContext;

  let context: Context | null = null;

  if (navigator.onLine) {
    try {
      context = await getContextWithTimeout();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return null;
      }
      // Network failure or timeout — fall back to the saved context.
      console.warn("[init] getMe failed, falling back to saved context:", err);
      context = savedContext;
    }
  } else {
    // Offline — use the saved context directly.
    context = savedContext;
  }

  if (context === null) {
    // Server reported no context, or we're offline with no saved context.
    onNoContextError();
    return null;
  }

  // Persist the fresh context from the server so it's available on next offline start.
  if (context !== savedContext) {
    await opfsClient.saveContext(context);
  }

  return {
    database,
    context,
    opfsClient,
    clientId,
    pending,
    errors,
    serverVersion,
  };

  /** Calls getMe with an abort timeout so we don't block startup on a slow network. */
  async function getContextWithTimeout(): Promise<Context | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      getContextTimeoutMs,
    );
    try {
      const ctx = await getContext(controller.signal);
      if (ctx !== null && restoreContext) {
        return await restoreContext(ctx);
      }
      return ctx;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
