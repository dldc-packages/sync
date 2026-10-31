export interface SanitizedAction {
  _action: unknown;
}

export interface SanitizedContext {
  _context: unknown; // sanitized context (not the original Context type)
}

export interface SanitizedOutboxAction {
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
  dedupKey?: string; // outbox.ts for Send, patch version for Sync
  count: number; // incremented on dedup hit (starts at 1)
}

export interface TDebugState {
  outboxCount: number;
  errors: StoredError[];
}

/**
 * The engine's persisted bookkeeping, stored next to the db and derived files.
 *
 * Distinct from the synced file content (the "state"), which the store holds as
 * an opaque ArrayBuffer. This is the per-origin metadata that all tabs share:
 * identity, the HLC clock, the outbox, error history, the version the db
 * corresponds to, and the last known context.
 */
export interface Bookkeeping {
  clientId: string; // UUID, separate from HLC
  hlc: string | null; // serialized last HLC timestamp
  outbox: SanitizedOutboxAction[];
  errors: StoredError[]; // local worker errors (not synced)
  serverVersion: string | null; // version ID of the db file
  context: SanitizedContext | null; // last known sanitized context (for offline startup fallback)
}

/**
 * Raw OPFS file access. Deliberately unaware of locking, versions or content —
 * the store owns all of that (see `createStore`), acquires the OPFS lock and
 * orchestrates the read-modify-write transactions against this interface.
 */
export interface Storage {
  readMeta(): Promise<Bookkeeping>;
  writeMeta(meta: Bookkeeping): Promise<void>;
  readDb(): Promise<Uint8Array>;
  writeDb(content: Uint8Array): Promise<void>;
  readDerived(): Promise<Uint8Array>;
  writeDerived(content: Uint8Array): Promise<void>;
  deleteDb(): Promise<void>;
}

export interface StorageParams {
  /** OPFS file holding the synced app data (the state content). */
  stateFileName: string;
  /** OPFS file holding the engine bookkeeping (clientId, hlc, outbox, …). */
  metaFileName: string;
  /** OPFS file holding the derived value (always configured — derived is always on). */
  derivedFileName: string;
}

export function createStorage({
  stateFileName,
  metaFileName,
  derivedFileName,
}: StorageParams): Storage {
  return {
    readMeta,
    writeMeta,
    readDb,
    writeDb,
    readDerived,
    writeDerived,
    deleteDb,
  };

  // --- Helpers ---

  async function readMeta(): Promise<Bookkeeping> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(metaFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      const size = accessHandle.getSize();
      if (size === 0) {
        const newMeta: Bookkeeping = {
          clientId: crypto.randomUUID(),
          hlc: null,
          outbox: [],
          errors: [],
          serverVersion: null,
          context: null,
        };
        // Persist the new meta immediately so clientId is saved
        writeMetaAt(accessHandle, newMeta);
        return newMeta;
      }
      const bytes = new Uint8Array(size);
      accessHandle.read(bytes, { at: 0 });
      const restored = JSON.parse(new TextDecoder().decode(bytes)) as Bookkeeping;
      return {
        ...restored,
        context: restored.context ?? null,
        errors: restored.errors ?? [],
      };
    } finally {
      accessHandle.close();
    }
  }

  async function writeMeta(meta: Bookkeeping): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(metaFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      writeMetaAt(accessHandle, meta);
    } finally {
      accessHandle.close();
    }
  }

  function writeMetaAt(accessHandle: FileSystemSyncAccessHandle, meta: Bookkeeping): void {
    accessHandle.truncate(0);
    const bytes = new TextEncoder().encode(JSON.stringify(meta));
    accessHandle.write(bytes, { at: 0 });
    accessHandle.flush();
  }

  async function readDb(): Promise<Uint8Array> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(stateFileName, { create: true });
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
    const handle = await root.getFileHandle(stateFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      accessHandle.truncate(0);
      accessHandle.write(content, { at: 0 });
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
  }

  async function readDerived(): Promise<Uint8Array> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(derivedFileName, { create: true });
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

  async function writeDerived(content: Uint8Array): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(derivedFileName, { create: true });
    const accessHandle = await handle.createSyncAccessHandle();
    try {
      accessHandle.truncate(0);
      accessHandle.write(content, { at: 0 });
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
  }

  async function deleteDb(): Promise<void> {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(stateFileName);
    } catch {
      // file may not exist
    }
  }
}
