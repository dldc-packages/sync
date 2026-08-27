import { createQueue } from "../../shared/queue.ts";
import type { ApiClient } from "./api.ts";
import type { Store } from "./store.ts";

interface SyncerParams<Action> {
  apiClient: ApiClient<Action>;
  clientId: string;
  signal: AbortSignal;
  store: Store<Action>;
  onPatchError: (version: string, error: unknown) => void;
}

export function createSyncer<Action>(
  { apiClient, clientId, signal, store, onPatchError }: SyncerParams<Action>,
): void {
  const applyPatchQueue = createQueue(signal);

  runSyncLoop();
  return;

  async function runSyncLoop(): Promise<void> {
    for await (
      const message of apiClient.sync(
        signal,
        clientId,
        () => store.getServerContent(),
      )
    ) {
      if (message.name === "Connected") {
        continue;
      }
      if (
        message.name === "InitialPatch" || message.name === "UpToDate" ||
        message.name === "Patch"
      ) {
        // Await so the for-await loop applies TCP backpressure: the stream
        // reader won't pull the next message until this patch is applied,
        // preventing unbounded queue growth.
        await applyPatchQueue.run(async () => {
          // InitialPatch / UpToDate / Patch all carry version + clientLastApplied
          const { version, clientLastApplied } = message.data;
          const patch = message.name === "UpToDate" ? null : message.data.patch;
          try {
            await store.applyPatch(version, patch, clientLastApplied);
          } catch (err) {
            // Log and rethrow — stop the sync loop so the in-memory state
            // doesn't diverge further. sync() will reconnect with backoff and
            // the server will send a fresh InitialPatch to re-sync.
            console.error("[syncer] Failed to apply patch:", err);
            onPatchError(version, err);
            throw err;
          }
        });
      }
    }
  }
}
