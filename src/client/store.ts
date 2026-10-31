import { apply } from "@dldc/librsync";
import "temporal-polyfill/global";
import { isDerivedResult, unwrapReducerState } from "../shared/derived.ts";
import { compareHLC, createHLC, parseHLC, serializeHLC } from "../shared/hlc.ts";
import type { TDerive, TRestoreAction, TStoreReducer } from "../shared/types.ts";
import { withLock } from "./lock.ts";
import { createOutboxStore } from "./outbox.ts";
import type {
  SanitizedAction,
  SanitizedContext,
  SanitizedOutboxAction,
  Storage,
  StoredError,
  TDebugState,
} from "./storage.ts";
import type { OutboxAction } from "./types.ts";

/** A lock acquisition function. Defaults to `navigator.locks` (see `lock.ts`). */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** Everything loaded from OPFS at boot (see `loadInitial`). */
export interface InitialLoad {
  context: SanitizedContext | null;
  outbox: SanitizedOutboxAction[];
  serverVersion: string | null;
  errors: StoredError[];
  clientId: string;
  database: Uint8Array;
  derived: Uint8Array;
}

export interface DispatchResult {
  ts: string; // the generated HLC timestamp
  outbox: SanitizedOutboxAction[]; // full outbox list (including the new action)
  serverContent: Uint8Array | null; // new DB if another tab changed it, null if unchanged
  serverVersion: string; // current server version from meta
}

export interface Store {
  getServerState(): Uint8Array;
  getServerVersion(): string | null;
  getState(): Uint8Array;
  getDerived(): Uint8Array;

  // Transactions — each acquires the OPFS lock itself and keeps the db,
  // derived and meta files consistent (same critical section).
  dispatch(action: SanitizedAction, dispatchId?: number): Promise<DispatchResult>;
  applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<void>;
  refreshFromOpfs(): Promise<void>;

  // Outbox persistence, used by the sender (also under the lock).
  getNextUnsent(): Promise<SanitizedOutboxAction | null>;
  markOutboxAsSent(ts: string): Promise<void>;

  // Meta/error persistence, used by the engine (also under the lock).
  getDebugState(): Promise<TDebugState>;
  addError(
    kind: StoredError["kind"],
    message: string,
    stack: string,
    dedupKey?: string,
  ): Promise<TDebugState>;
  clearError(id: string): Promise<TDebugState>;
  clearAllErrors(): Promise<TDebugState>;
  refresh(): Promise<TDebugState>;
  forceRefresh(): Promise<TDebugState>;
}

export interface StoreParams<Action, Context> {
  context: Context;
  initialServerVersion: string | null;
  initialOutbox: SanitizedOutboxAction[];
  initialState: Uint8Array;
  initialDerived: Uint8Array;
  storage: Storage;
  opfsLockName: string;
  /** Lock implementation; defaults to `navigator.locks`. Injectable for tests. */
  lock?: Lock;
  restoreAction: TRestoreAction<Action>;
  reducer: TStoreReducer<Action, Context>;
  derive: TDerive;
  maxStoredErrors: number;
  onState: (content: Uint8Array, derived: Uint8Array, dispatchId?: number) => void;
  onStateChange: (outboxCount: number) => void;
}

/**
 * The store is the single owner of the OPFS lock. It composes the raw
 * `Storage` into consistent transactions: state, derived and bookkeeping are
 * updated together inside one `withLock` acquisition, so a racing tab's patch
 * can never land between the db and derived writes on disk.
 */
export function createStore<Action, Context>({
  context,
  initialServerVersion,
  initialOutbox,
  initialState,
  initialDerived,
  storage,
  opfsLockName,
  lock = withLock,
  restoreAction,
  reducer,
  derive,
  maxStoredErrors,
  onState: onDatabase,
  onStateChange,
}: StoreParams<Action, Context>): Store {
  let serverState: Uint8Array = initialState;
  let serverVersion: string | null = initialServerVersion;
  let serverDerived: Uint8Array = derive(serverState, initialDerived);

  const outboxStore = createOutboxStore(initialOutbox, restoreAction);

  const initialLocal = rebase(serverState, outboxStore.getOutbox(), serverDerived);
  let localState = initialLocal.state;
  let localDerived = initialLocal.derived;

  return {
    applyPatch,
    dispatch,
    refreshFromOpfs,
    getNextUnsent,
    markOutboxAsSent,
    getDebugState,
    addError,
    clearError,
    clearAllErrors,
    refresh,
    forceRefresh,
    getServerState: () => serverState,
    getState: () => localState,
    getServerVersion: () => serverVersion,
    getDerived: () => localDerived,
  };

  function runInLock<T>(fn: () => Promise<T>): Promise<T> {
    return lock(opfsLockName, fn);
  }

  async function dispatch(action: SanitizedAction, dispatchId?: number): Promise<DispatchResult> {
    const result = await runInLock(async () => {
      const meta = await storage.readMeta();

      // Create new TS from last TS
      const hlc = createHLC(meta.hlc ? parseHLC(meta.hlc) : null);
      const ts = hlc.send();
      const tsStr = serializeHLC(ts);
      meta.hlc = tsStr;
      // Append to the outbox
      meta.outbox.push({ ts: tsStr, action, sent: false });

      // If another tab changed the db meanwhile, read it and persist the derived
      // for it in the same critical section as the meta write.
      let serverContent: Uint8Array | null = null;
      if (meta.serverVersion !== serverVersion) {
        serverContent = await storage.readDb();
        await persistDerived(serverContent);
      }

      await storage.writeMeta(meta);

      return {
        ts: tsStr,
        outbox: meta.outbox,
        serverContent,
        serverVersion: meta.serverVersion ?? "",
      };
    });

    applyStateChange(result.serverContent, result.serverVersion, result.outbox, dispatchId);
    return result;
  }

  async function applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<void> {
    const result = await runInLock(async () => {
      const meta = await storage.readMeta();

      // Version-based dedup: if another tab already handled this version, stop
      if (meta.serverVersion === version) {
        const serverContent = await storage.readDb();
        await persistDerived(serverContent);
        return { serverContent, outbox: meta.outbox, serverVersion: version };
      }

      // Apply the patch to the db file (or just read it for UpToDate).
      let serverContent: Uint8Array;
      if (patch !== null) {
        const current = await storage.readDb();
        serverContent = apply(current, patch);
        await storage.writeDb(serverContent);
      } else {
        serverContent = await storage.readDb();
      }

      // Update meta: new server version, drop acked outbox actions (applies to
      // all message types: the server may have applied actions without the
      // content changing).
      meta.serverVersion = version;
      if (clientLastApplied !== null) {
        meta.outbox = meta.outbox.filter(
          (a) => compareHLC(parseHLC(a.ts), parseHLC(clientLastApplied)) > 0,
        );
      }
      await storage.writeMeta(meta);

      // Persist the derived for the new server content in the same critical
      // section as the db write, so the pair on disk always belongs to the
      // same content version.
      await persistDerived(serverContent);

      return { serverContent, outbox: meta.outbox, serverVersion: version };
    });

    applyStateChange(result.serverContent, result.serverVersion, result.outbox);
  }

  async function refreshFromOpfs(): Promise<void> {
    const result = await runInLock(async () => {
      const meta = await storage.readMeta();
      const serverContent = meta.serverVersion !== serverVersion ? await storage.readDb() : null;
      if (serverContent !== null) {
        await persistDerived(serverContent);
      }
      return {
        serverContent,
        outbox: meta.outbox,
        serverVersion: meta.serverVersion ?? "",
      };
    });

    applyStateChange(result.serverContent, result.serverVersion, result.outbox);
  }

  /**
   * Compute the derived for `content` (incrementally from the current value),
   * persist it, and update the in-memory `serverDerived`. Must be called inside
   * the OPFS lock, right next to the db write.
   */
  async function persistDerived(content: Uint8Array): Promise<void> {
    serverDerived = derive(content, serverDerived);
    await storage.writeDerived(serverDerived);
  }

  function getNextUnsent(): Promise<SanitizedOutboxAction | null> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      return meta.outbox.find((a) => !a.sent) ?? null;
    });
  }

  function markOutboxAsSent(ts: string): Promise<void> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      const entry = meta.outbox.find((a) => a.ts === ts);
      if (entry) {
        entry.sent = true;
        await storage.writeMeta(meta);
      }
    });
  }

  function getDebugState(): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      return { outboxCount: meta.outbox.length, errors: meta.errors };
    });
  }

  function addError(
    kind: StoredError["kind"],
    message: string,
    stack: string,
    dedupKey?: string,
  ): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      if (dedupKey !== undefined) {
        const existing = meta.errors.find((e) => e.dedupKey === dedupKey);
        if (existing) {
          existing.count += 1;
          existing.ts = Temporal.Now.instant().toString();
          existing.message = message;
          existing.stack = stack;
          await storage.writeMeta(meta);
          return { outboxCount: meta.outbox.length, errors: meta.errors };
        }
      }
      meta.errors.push({
        id: crypto.randomUUID(),
        ts: Temporal.Now.instant().toString(),
        kind,
        message,
        stack,
        dedupKey,
        count: 1,
      });
      // Cap stored errors to prevent unbounded growth
      if (meta.errors.length > maxStoredErrors) {
        meta.errors.sort((a, b) => b.ts.localeCompare(a.ts));
        meta.errors = meta.errors.slice(0, maxStoredErrors);
      }
      await storage.writeMeta(meta);
      return {
        outboxCount: meta.outbox.length,
        errors: meta.errors,
      };
    });
  }

  function clearError(id: string): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      meta.errors = meta.errors.filter((e) => e.id !== id);
      await storage.writeMeta(meta);
      return {
        outboxCount: meta.outbox.length,
        errors: meta.errors,
      };
    });
  }

  function clearAllErrors(): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      meta.errors = [];
      await storage.writeMeta(meta);
      return {
        outboxCount: meta.outbox.length,
        errors: meta.errors,
      };
    });
  }

  /**
   * Refresh: clear local errors and delete the db file, reset serverVersion
   * so the sync loop reconnects and fetches a fresh copy from the server.
   * Outbox actions are preserved.
   */
  function refresh(): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      meta.errors = [];
      meta.serverVersion = null;
      await storage.writeMeta(meta);
      await storage.deleteDb();
      return {
        outboxCount: meta.outbox.length,
        errors: meta.errors,
      };
    });
  }

  /**
   * Force refresh: clear everything — outbox actions, local errors, and the
   * db file. Resets serverVersion so the sync loop reconnects fresh.
   * Destructive — unsent actions and error history are lost.
   */
  function forceRefresh(): Promise<TDebugState> {
    return runInLock(async () => {
      const meta = await storage.readMeta();
      meta.outbox = [];
      meta.errors = [];
      meta.serverVersion = null;
      await storage.writeMeta(meta);
      await storage.deleteDb();
      return {
        outboxCount: meta.outbox.length,
        errors: meta.errors,
      };
    });
  }

  /**
   * Shared logic for server-content changes (dispatch, patches, cross-tab
   * refreshes). The on-disk files were already written by the caller under the
   * lock; this commits the in-memory mirror and emits the new local content.
   *
   * Incremental path: if the server did not change and the previous outbox list
   * is a prefix of the new one (only appends), apply just the newly-appended
   * actions on top of the current localContent instead of rebasing everything
   * from serverContent. If nothing changed at all (appended is empty), skip
   * the database emission entirely.
   */
  function applyStateChange(
    newServerContent: Uint8Array | null,
    newServerVersion: string,
    newOutbox: SanitizedOutboxAction[],
    dispatchId?: number,
  ) {
    const serverChanged = newServerContent !== null;
    if (serverChanged) {
      serverState = newServerContent;
      serverVersion = newServerVersion;
    }

    const { appended } = outboxStore.setOutbox(newOutbox);
    if (!serverChanged && appended !== null) {
      if (appended.length === 0) {
        return; // nothing changed
      }
      const rebased = rebase(localState, appended, localDerived);
      localState = rebased.state;
      localDerived = rebased.derived;
      emit(dispatchId);
      return;
    }

    // Fallback: full rebase of the whole outbox on top of serverContent.
    const rebased = rebase(serverState, outboxStore.getOutbox(), serverDerived);
    localState = rebased.state;
    localDerived = rebased.derived;
    emit(dispatchId);
  }

  function emit(dispatchId?: number) {
    onDatabase(localState, localDerived, dispatchId);
    onStateChange(outboxStore.getOutbox().length);
  }

  /**
   * Reapply all outbox actions on top of `content`, tracking derived.
   *
   * Each `reducer()` call deserializes -> applies -> exports. For N outbox
   * actions this is O(N x DB_size); acceptable for small outbox lists. The
   * reducer receives the current derived: a raw `Uint8Array` result keeps the
   * derived unchanged, `{ state, derived }` replaces it.
   */
  function rebase(
    content: Uint8Array,
    outboxActions: OutboxAction<Action>[],
    baseDerived: Uint8Array,
  ): { state: Uint8Array; derived: Uint8Array } {
    if (outboxActions.length === 0) {
      return { state: content, derived: baseDerived };
    }
    let result = content;
    let currentDerived = baseDerived;
    for (const { action } of outboxActions) {
      const out = reducer(result, context, action, currentDerived);
      result = unwrapReducerState(out);
      if (isDerivedResult(out)) {
        currentDerived = out.derived;
      }
    }
    return { state: result, derived: currentDerived };
  }
}

/**
 * Boot-time read of the three OPFS files under the lock, returning a coherent
 * snapshot (meta + db + derived of the same content version). Runs before the
 * store exists (the store is constructed from its result), so it lives here,
 * in the module that owns the lock.
 */
export async function loadInitial(storage: Storage, opfsLockName: string): Promise<InitialLoad> {
  return withLock(opfsLockName, async () => {
    const meta = await storage.readMeta();
    return {
      context: meta.context,
      outbox: meta.outbox,
      serverVersion: meta.serverVersion,
      errors: meta.errors,
      clientId: meta.clientId,
      database: await storage.readDb(),
      derived: await storage.readDerived(),
    };
  });
}

/** Persist the context so it can be used on the next offline startup. */
export async function saveContext(
  storage: Storage,
  opfsLockName: string,
  context: SanitizedContext,
): Promise<void> {
  return withLock(opfsLockName, async () => {
    const meta = await storage.readMeta();
    meta.context = context;
    await storage.writeMeta(meta);
  });
}
