import { readFileSync, writeFileSync } from "node:fs";
import { diff, signature } from "@dldc/librsync";
import { createSubscription, type TSubscriptionCallback, type TUnsubscribe } from "@dldc/pubsub";

export interface TStoreUpdateContext {
  clientId: string | null;
  clientLastApplied: string | null;
}

export interface TFileStoreEvent {
  patch: Uint8Array;
  version: string; // unique ID for this DB version
  clientId: string | null; // client that triggered this update, null if non-client
  clientLastApplied: string | null; // HLC ts applied by the triggering client
}

export interface TFileStore {
  getCurrent(): Uint8Array;
  compare(data: Uint8Array): { patch: Uint8Array | null; version: string };
  subscribe(callback: TSubscriptionCallback<TFileStoreEvent>): TUnsubscribe;
  update(updater: (current: Uint8Array) => Uint8Array, context: TStoreUpdateContext): void;
}

export interface FileStoreParams {
  getDbVersion: () => string | null;
  setDbVersion: (version: string) => void;
  filePath: string;
}

export function createFileStore({
  getDbVersion,
  setDbVersion,
  filePath,
}: FileStoreParams): TFileStore {
  const subscriptions = createSubscription<TFileStoreEvent>();
  let content: Uint8Array = readFileOrEmpty(filePath);
  // Read persisted version from the state DB (survives restarts). If none
  // (fresh state DB), generate one and persist it so the version is stable
  // across restarts as long as the DB content doesn't change.
  let version = getDbVersion() ?? crypto.randomUUID();
  setDbVersion(version);

  return {
    compare,
    subscribe: subscriptions.subscribe,
    update,
    getCurrent,
  };

  function getCurrent(): Uint8Array {
    return content;
  }

  function compare(checksum: Uint8Array): { patch: Uint8Array | null; version: string } {
    const blockSize = readBlockSize(checksum);
    const currentChecksum = signature(content, blockSize);
    if (filesEqual(checksum, currentChecksum)) {
      return { patch: null, version };
    }
    return { patch: diff(checksum, content), version };
  }

  function update(
    updater: (current: Uint8Array) => Uint8Array,
    context: TStoreUpdateContext,
  ): void {
    let newContent: Uint8Array;
    try {
      newContent = updater(content);
    } catch (e) {
      console.error("Error updating store:", e);
      return;
    }
    const patch = diff(signature(content, 1024), newContent);
    const newVersion = crypto.randomUUID();
    // Persist version BEFORE writing the DB file. If a crash happens between
    // the two, the state DB has the new version while the DB file still has
    // the old content. On restart, clients see a "new" version and re-read the
    // DB (which is the same content they already have) — a redundant read, not
    // a correctness bug. The reverse order (DB first, then version) would be
    // unsafe: a crash between would give new content + old version, causing
    // clients to skip the patch (version dedup) and miss the update.
    setDbVersion(newVersion);
    writeFileSync(filePath, newContent);
    content = newContent;
    version = newVersion;
    subscriptions.emit({
      patch,
      version: newVersion,
      clientId: context.clientId,
      clientLastApplied: context.clientLastApplied,
    });
  }
}

function readFileOrEmpty(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (e) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return new Uint8Array();
    }
    throw e;
  }
}

// rs\x016
const RS_MD4_SIG_MAGIC = 0x72730136;

/**
 * Check that the first u32 is RS_MD4_SIG_MAGIC
 * Then extract the second u32 as the block size
 */
function readBlockSize(checksum: Uint8Array): number {
  const byteLength = 8; // u32 + u32
  const littleEndian = false; // Using big endian
  const view = new DataView(checksum.buffer, checksum.byteOffset, byteLength);
  const magic = view.getUint32(0, littleEndian);
  if (magic !== RS_MD4_SIG_MAGIC) {
    throw new Error("Invalid checksum");
  }
  return view.getUint32(4, false);
}

function filesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let i = 0; i < left.byteLength; i++) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
