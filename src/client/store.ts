import type { TRestoreAction, TStoreReducer } from "../shared/types.ts";
import type { DispatchResult, OpfsClient, SanitizedPendingAction } from "./opfs.ts";
import { createPendingStore } from "./pendings.ts";
import type { PendingAction } from "./types.ts";

export interface Store<Action> {
  applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ): Promise<void>;
  applyDispatchResult(result: DispatchResult): void;
  refreshFromOpfs(): Promise<void>;
  getServerContent(): Uint8Array;
  getLocalContent(): Uint8Array;
  getServerVersion(): string | null;
}

export interface StoreParams<Action, Context> {
  context: Context;
  initialServerVersion: string | null;
  initialPending: SanitizedPendingAction[];
  initialDatabase: Uint8Array;
  opfsClient: OpfsClient;
  restoreAction: TRestoreAction<Action>;
  reducer: TStoreReducer<Action, Context>;
  onDatabase: (content: Uint8Array) => void;
  onStateChange: (pendingCount: number) => void;
}

export function createStore<Action, Context>({
  context,
  initialServerVersion,
  initialPending,
  initialDatabase,
  opfsClient,
  restoreAction,
  reducer,
  onDatabase,
  onStateChange,
}: StoreParams<Action, Context>): Store<Action> {
  let serverContent: Uint8Array = initialDatabase;
  let serverVersion: string | null = initialServerVersion;
  const pendingsStore = createPendingStore(initialPending, restoreAction);
  let localContent = rebase(serverContent, pendingsStore.getPendings());

  return {
    applyPatch,
    applyDispatchResult,
    refreshFromOpfs,
    getServerContent: () => serverContent,
    getLocalContent: () => localContent,
    getServerVersion: () => serverVersion,
  };

  async function applyPatch(
    version: string,
    patch: Uint8Array | null,
    clientLastApplied: string | null,
  ) {
    const result = await opfsClient.applyPatchInLock(version, patch, clientLastApplied);
    if (result.serverContent !== null) {
      serverContent = result.serverContent;
      serverVersion = result.serverVersion;
    }
    pendingsStore.setPendings(result.pending);
    const allPending = pendingsStore.getPendings();

    // Rebase: reapply remaining pending on top of serverContent
    localContent = rebase(serverContent, allPending);
    onDatabase(localContent);
    onStateChange(allPending.length);
  }

  function applyDispatchResult(result: DispatchResult) {
    applyStateChange(result.serverContent, result.serverVersion, result.pending);
  }

  async function refreshFromOpfs() {
    const result = await opfsClient.refreshState(serverVersion);
    applyStateChange(result.serverContent, result.serverVersion, result.pending);
  }

  /**
   * Shared logic for dispatch results and cross-tab refreshes.
   *
   * Incremental path: if the server did not change and the previous pending
   * list is a prefix of the new one (only appends), apply just the
   * newly-appended actions on top of the current localContent instead of
   * rebasing everything from serverContent. If nothing changed at all
   * (appended is empty), skip the database emission entirely.
   */
  function applyStateChange(
    newServerContent: Uint8Array | null,
    newServerVersion: string,
    newPending: SanitizedPendingAction[],
  ) {
    if (newServerContent !== null) {
      serverContent = newServerContent;
      serverVersion = newServerVersion;
    }

    const { appended } = pendingsStore.setPendings(newPending);
    // Incremental path: server unchanged & appended actions only, rebase just the appended actions on top of localContent
    if (newServerContent === null && appended !== null) {
      if (appended.length === 0) {
        return; // nothing changed
      }
      localContent = rebase(localContent, appended);
      onDatabase(localContent);
      onStateChange(pendingsStore.getPendings().length);
      return;
    }

    // Fallback: full rebase of all pending on top of serverContent.
    localContent = rebase(serverContent, pendingsStore.getPendings());
    onDatabase(localContent);
    onStateChange(pendingsStore.getPendings().length);
  }

  /**
   * Reapply all pending actions on top of serverContent.
   *
   * Each `reducer()` call deserializes -> applies -> exports. For N pending
   * actions this is O(N x DB_size); acceptable for small pending lists.
   */
  function rebase(content: Uint8Array, pendingActions: PendingAction<Action>[]): Uint8Array {
    if (pendingActions.length === 0) return content;
    let result = content;
    for (const { action } of pendingActions) {
      result = reducer(result, context, action);
    }
    return result;
  }
}
