import { apply } from "@dldc/librsync";
import {
  compareHLC,
  createHLC,
  parseHLC,
  serializeHLC,
} from "../shared/hlc.ts";
import { withLock } from "./lock.ts";

export interface SanitizedAction {
  _action: unknown;
}

export interface SanitizedContext {
  _context: unknown; // sanitized context (not the original Context type)
}

export interface SanitizedPendingAction {
  ts: string; // HLC timestamp string
  action: SanitizedAction; // sanitized action (not the original Action type)
  sent: boolean; // true once the HTTP dispatch returned 200 (persisted, shared across tabs)
}

export interface StoredError {
  id: string;
  ts: string; // ISO timestamp of last occurrence
  kind: "Startup" | "Dispatch" | "Send" | "Sync";
  message: string;
  stack: string;
  dedupKey?: string; // pending.ts for Send, patch version for Sync
  count: number; // incremented on dedup hit (starts at 1)
}

export interface TDebugState {
  pendingCount: number;
  errors: StoredError[];
}

export interface SyncState {
  clientId: string; // UUID, separate from HLC
  hlc: string | null; // serialized last HLC timestamp
  pending: SanitizedPendingAction[];
  errors: StoredError[]; // local worker errors (not synced)
  serverVersion: string | null; // version ID of the DB in OPFS
  context: SanitizedContext | null; // last known sanitized context (for offline startup fallback)
}

export interface InitialLoad {
  context: SanitizedContext | null;
  pending: SanitizedPendingAction[];
  serverVersion: string | null;
  errors: StoredError[];
  clientId: string;
  database: Uint8Array;
}

export interface DispatchResult {
  ts: string; // the generated HLC timestamp
  pending: SanitizedPendingAction[]; // full pending list (including the new action)
  serverContent: Uint8Array | null; // new DB if another tab changed it, null if unchanged
  serverVersion: string; // current server version from state
}

export interface PatchResult {
  serverContent: Uint8Array | null; // new DB if version changed (patch applied or cross-tab), null if same version
  pending: SanitizedPendingAction[]; // updated pending list (after dropping acked)
  serverVersion: string; // the version after this operation
}

export interface RefreshResult {
  pending: SanitizedPendingAction[]; // current pending list from OPFS
  serverContent: Uint8Array | null; // new DB if version changed (another tab applied a patch), null if unchanged
  serverVersion: string; // current server version from state
}

export interface OpfsClient {
  /**
   * Called when another tab signals a dispatch via BroadcastChannel.
   * Inside the lock: read the state, compare worker's serverVersion with
   * state's serverVersion (another tab may have applied a patch), and return
   * the current pending list + new DB (if version differed).
   */
  refreshState(
    workerServerVersion: string | null,
  ): Promise<RefreshResult>;
  /** Called once on worker startup. Reads both the state file and DB under the lock. */
  loadInitial(): Promise<InitialLoad>;
  /** Persist the context so it can be used on the next offline startup. */
  saveContext(context: SanitizedContext): Promise<void>;
  /**
   * Called on dispatch. Inside the lock:
   * - Read the state
   * - Create new TS from last TS (stored in state)
   * - Add action + TS to pending
   * - Compare worker's serverVersion with state's serverVersion (another tab may have changed the DB)
   * - If different, read the DB from OPFS
   * - Save the updated state
   * - Return pendings + new DB (if version differed)
   */
  dispatchInLock(
    action: SanitizedAction,
    workerServerVersion: string | null,
  ): Promise<DispatchResult>;

  /**
   * Called on sync messages (InitialPatch, Patch, UpToDate). Inside the lock:
   * - Read the state
   * - Compare message version with state's serverVersion
   * - If same, another tab already handled this version — return null for DB, return current pendings
   * - If different:
   *   - If patch is non-null: read DB from OPFS, apply patch, save DB
   *   - If patch is null (UpToDate): read DB from OPFS only if version differs (another tab changed it)
   *   - Update state.serverVersion, drop acked pending, save state
   * - Return DB (or null if unchanged) + pendings
   *
   * The `clientLastApplied` filtering applies to ALL message types, including UpToDate:
   * the server may have applied some of the client's actions without the DB content
   * changing (the client's signature matched), so pending actions must still be dropped.
   */
  applyPatchInLock(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<PatchResult>;
  /** Read the first unsent pending action from OPFS (under the lock). */
  getNextUnsentPending(): Promise<SanitizedPendingAction | null>;

  /** Mark a pending action as sent by its timestamp (under the lock). */
  markPendingAsSent(ts: string): Promise<void>;

  /** Read the current debug state (pending count + stored errors) under the lock. */
  getDebugState(): Promise<TDebugState>;

  /** Store an error in the OPFS state. Deduplicates by dedupKey if provided. */
  addError(
    kind: StoredError["kind"],
    message: string,
    stack: string,
    dedupKey?: string,
  ): Promise<TDebugState>;

  /** Remove a single error by id (under the lock). */
  clearError(id: string): Promise<TDebugState>;

  /** Remove all stored errors (under the lock). */
  clearAllErrors(): Promise<TDebugState>;

  /**
   * Refresh: clear local errors and delete the DB file, reset serverVersion
   * so the sync loop reconnects and fetches a fresh copy from the server.
   * Pending actions are preserved.
   */
  refresh(): Promise<TDebugState>;

  /**
   * Force refresh: clear everything — pending actions, local errors, and the
   * DB file. Resets serverVersion so the sync loop reconnects fresh.
   * Destructive — unsent actions and error history are lost.
   */
  forceRefresh(): Promise<TDebugState>;
}

export interface OpfsClientParams {
  dbFileName: string;
  stateFileName: string;
  maxStoredErrors: number;
  opfsLockName: string;
}

export function createOpfsClient(
  { dbFileName, maxStoredErrors, stateFileName, opfsLockName }:
    OpfsClientParams,
): OpfsClient {
  return {
    refreshState,
    loadInitial,
    saveContext,
    dispatchInLock,
    applyPatchInLock,
    getNextUnsentPending,
    markPendingAsSent,
    addError,
    getDebugState,
    clearAllErrors,
    clearError,
    refresh,
    forceRefresh,
  };

  function refreshState(
    workerServerVersion: string | null,
  ): Promise<RefreshResult> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      let serverContent: Uint8Array | null = null;
      if (state.serverVersion !== workerServerVersion) {
        serverContent = await readDb();
      }
      return {
        pending: state.pending,
        serverContent,
        serverVersion: state.serverVersion ?? "",
      };
    });
  }

  function loadInitial(): Promise<InitialLoad> {
    return withLock(opfsLockName, async (): Promise<InitialLoad> => {
      const state = await readState();
      const {
        serverVersion,
        clientId,
        pending,
        errors,
        context,
      } = state;
      const database = await readDb();
      return {
        database,
        context,
        pending,
        clientId,
        errors,
        serverVersion,
      };
    });
  }

  function saveContext(context: SanitizedContext): Promise<void> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      state.context = context;
      await writeState(state);
    });
  }

  function dispatchInLock(
    action: SanitizedAction,
    workerServerVersion: string | null,
  ): Promise<DispatchResult> {
    return withLock(opfsLockName, async () => {
      const state = await readState();

      // Create new TS from last TS
      const hlc = createHLC(state.hlc ? parseHLC(state.hlc) : null);
      const ts = hlc.send();
      const tsStr = serializeHLC(ts);
      state.hlc = tsStr;
      // Add to pending
      state.pending.push({ ts: tsStr, action, sent: false });

      // Check if DB changed (another tab applied a patch)
      let serverContent: Uint8Array | null = null;
      if (state.serverVersion !== workerServerVersion) {
        serverContent = await readDb();
      }

      // Save updated state
      await writeState(state);

      return {
        ts: tsStr,
        pending: state.pending,
        serverContent,
        serverVersion: state.serverVersion ?? "",
      };
    });
  }

  function applyPatchInLock(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<PatchResult> {
    return withLock(opfsLockName, async () => {
      const state = await readState();

      // Version-based dedup: if another tab already handled this version, stop
      if (state.serverVersion === version) {
        return {
          serverContent: await readDb(),
          pending: state.pending,
          serverVersion: version,
        };
      }

      // Apply patch if provided
      let db: Uint8Array | null = null;
      if (patch !== null) {
        db = await readDb();
        db = apply(db, patch);
        await writeDb(db);
      } else {
        // UpToDate: another tab may have changed the DB, read it if version differs
        db = await readDb();
      }

      // Update state
      state.serverVersion = version;
      // Drop acked pending actions (applies to all message types)
      if (clientLastApplied !== null) {
        state.pending = state.pending.filter(
          (p) => compareHLC(parseHLC(p.ts), parseHLC(clientLastApplied)) > 0,
        );
      }
      await writeState(state);

      return {
        serverContent: db,
        pending: state.pending,
        serverVersion: version,
      };
    });
  }

  function getNextUnsentPending(): Promise<SanitizedPendingAction | null> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      return state.pending.find((p) => !p.sent) ?? null;
    });
  }

  function markPendingAsSent(ts: string): Promise<void> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      const pending = state.pending.find((p) => p.ts === ts);
      if (pending) {
        pending.sent = true;
        await writeState(state);
      }
    });
  }

  function getDebugState(): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      return { pendingCount: state.pending.length, errors: state.errors };
    });
  }

  function addError(
    kind: StoredError["kind"],
    message: string,
    stack: string,
    dedupKey?: string,
  ): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      if (dedupKey !== undefined) {
        const existing = state.errors.find((e) => e.dedupKey === dedupKey);
        if (existing) {
          existing.count += 1;
          existing.ts = Temporal.Now.instant().toString();
          existing.message = message;
          existing.stack = stack;
          await writeState(state);
          return { pendingCount: state.pending.length, errors: state.errors };
        }
      }
      state.errors.push({
        id: crypto.randomUUID(),
        ts: Temporal.Now.instant().toString(),
        kind,
        message,
        stack,
        dedupKey,
        count: 1,
      });
      // Cap stored errors to prevent unbounded growth
      if (state.errors.length > maxStoredErrors) {
        state.errors.sort((a, b) => b.ts.localeCompare(a.ts));
        state.errors = state.errors.slice(0, maxStoredErrors);
      }
      await writeState(state);
      return {
        pendingCount: state.pending.length,
        errors: state.errors,
      };
    });
  }

  function clearError(id: string): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      state.errors = state.errors.filter((e) => e.id !== id);
      await writeState(state);
      return {
        pendingCount: state.pending.length,
        errors: state.errors,
      };
    });
  }

  /** Remove all stored errors (under the lock). */
  function clearAllErrors(): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      state.errors = [];
      await writeState(state);
      return {
        pendingCount: state.pending.length,
        errors: state.errors,
      };
    });
  }

  /**
   * Refresh: clear local errors and delete the DB file, reset serverVersion
   * so the sync loop reconnects and fetches a fresh copy from the server.
   * Pending actions are preserved.
   */
  function refresh(): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      state.errors = [];
      state.serverVersion = null;
      await writeState(state);
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry(dbFileName);
      } catch {
        // file may not exist
      }
      return {
        pendingCount: state.pending.length,
        errors: state.errors,
      };
    });
  }

  function forceRefresh(): Promise<TDebugState> {
    return withLock(opfsLockName, async () => {
      const state = await readState();
      state.pending = [];
      state.errors = [];
      state.serverVersion = null;
      await writeState(state);
      const root = await navigator.storage.getDirectory();
      try {
        await root.removeEntry(dbFileName);
      } catch {
        // file may not exist
      }
      return {
        pendingCount: state.pending.length,
        errors: state.errors,
      };
    });
  }

  // --- Internal helpers (run inside the lock) ---

  async function readState(): Promise<SyncState> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(stateFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      const size = accessHandle.getSize();
      if (size === 0) {
        const newState: SyncState = {
          clientId: crypto.randomUUID(),
          hlc: null,
          pending: [],
          errors: [],
          serverVersion: null,
          context: null,
        };
        // Persist the new state immediately so clientId is saved
        writeStateAt(accessHandle, newState);
        return newState;
      }
      const bytes = new Uint8Array(size);
      accessHandle.read(bytes, { at: 0 });
      const restored = JSON.parse(new TextDecoder().decode(bytes)) as SyncState;
      return {
        ...restored,
        context: restored.context ?? null,
        errors: restored.errors ?? [],
      };
    } finally {
      accessHandle.close();
    }
  }

  async function writeState(state: SyncState): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(stateFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      writeStateAt(accessHandle, state);
    } finally {
      accessHandle.close();
    }
  }

  function writeStateAt(
    accessHandle: FileSystemSyncAccessHandle,
    state: SyncState,
  ): void {
    accessHandle.truncate(0);
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    accessHandle.write(bytes, { at: 0 });
    accessHandle.flush();
  }

  async function readDb(): Promise<Uint8Array> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(dbFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      const size = accessHandle.getSize();
      if (size === 0) return new Uint8Array(0);
      const buffer = new Uint8Array(size);
      accessHandle.read(buffer, { at: 0 });
      return buffer;
    } finally {
      accessHandle.close();
    }
  }

  async function writeDb(content: Uint8Array): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(dbFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      accessHandle.truncate(0);
      accessHandle.write(content, { at: 0 });
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
  }
}
