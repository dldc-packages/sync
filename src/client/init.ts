import type {
  TDerive,
  TGetContext,
  TGetDerive,
  TGetStoreReducer,
  TSanitizeContext,
  TStoreReducer,
} from "../shared/types.ts";
import { UnauthorizedError } from "./errors.ts";
import { loadInitial, saveContext } from "./store.ts";
import {
  createStorage,
  type SanitizedContext,
  type SanitizedOutboxAction,
  type Storage,
  type StoredError,
} from "./storage.ts";

/** Values computed once during `start()` and never reassigned. */
export interface EngineInit<Action, Context> {
  reducer: TStoreReducer<Action, Context>;
  derive: TDerive;
  context: SanitizedContext;
  clientId: string;
  outbox: SanitizedOutboxAction[];
  serverVersion: string | null;
  errors: StoredError[];
  database: Uint8Array;
  derived: Uint8Array;
  storage: Storage;
}

export interface InitParams<Action, Context> {
  getReducer: TGetStoreReducer<Action, Context>;
  getDerive: TGetDerive;
  onNoContextError: () => void;
  onUnauthorized: () => void;
  getContext: TGetContext<Context>;
  sanitizeContext: TSanitizeContext<Context>;
  stateFileName: string;
  metaFileName: string;
  getContextTimeoutMs: number;
  opfsLockName: string;
  derivedFileName: string;
}

export async function init<Action, Context>({
  onNoContextError,
  onUnauthorized,
  getContext,
  getReducer,
  getDerive,
  sanitizeContext,
  stateFileName,
  metaFileName,
  getContextTimeoutMs,
  opfsLockName,
  derivedFileName,
}: InitParams<Action, Context>): Promise<EngineInit<Action, Context> | null> {
  const storage = createStorage({
    stateFileName,
    metaFileName,
    derivedFileName,
  });

  // In parallel
  // - load the reducer
  // - load the derive function
  // - restore existing state from opfs + restore or fetch context
  const [initState, reducer, derive] = await Promise.all([
    initOpfsAndRestoreContext(),
    getReducer(),
    getDerive(),
  ]);

  if (!initState) {
    return null;
  }

  return {
    ...initState,
    reducer,
    derive,
    storage,
  };

  async function initOpfsAndRestoreContext(): Promise<Omit<
    EngineInit<Action, Context>,
    "reducer" | "derive" | "storage"
  > | null> {
    // Load persisted state + DB from OPFS (under the lock) — load BEFORE
    // getMe so we can fall back to the saved context if the network is
    // unavailable. The store owns this lock; the boot read lives in store.ts.
    const {
      context: savedContext,
      database,
      clientId,
      outbox,
      errors,
      serverVersion,
      derived,
    } = await loadInitial(storage, opfsLockName);

    let context = savedContext;

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
    }

    if (context === null) {
      // Server reported no context, or we're offline with no saved context.
      onNoContextError();
      return null;
    }

    // Persist the fresh context from the server so it's available on next offline start.
    if (context !== savedContext) {
      await saveContext(storage, opfsLockName, context);
    }

    return { context, database, clientId, outbox, errors, serverVersion, derived };
  }

  /** Calls getMe with an abort timeout so we don't block startup on a slow network. */
  async function getContextWithTimeout(): Promise<SanitizedContext | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), getContextTimeoutMs);
    try {
      const ctx = await getContext(controller.signal);
      if (ctx !== null) {
        return { _context: sanitizeContext(ctx) };
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
